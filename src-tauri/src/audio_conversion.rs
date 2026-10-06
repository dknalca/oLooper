use crate::player::LoopBuffer;

/// Encode decoded mono/stereo audio to constant-bitrate 320 kbps MP3.
/// Common MP3 MPEG-1 sample rates are preserved; other supported PCM rates are
/// converted to 44.1 kHz before encoding.
pub fn wav_pcm_to_mp3_320(buffer: &LoopBuffer) -> Result<Vec<u8>, String> {
    if buffer.rate == 0 || buffer.frames() == 0 {
        return Err("WAV contains no decodable audio".to_string());
    }
    if !matches!(buffer.channels, 1 | 2) {
        return Err("MP3 conversion supports mono or stereo WAV files".to_string());
    }

    let output_rate = if matches!(buffer.rate, 32_000 | 44_100 | 48_000) {
        buffer.rate
    } else {
        44_100
    };
    let samples = if output_rate == buffer.rate {
        buffer.samples.clone()
    } else {
        let source =
            rodio::buffer::SamplesBuffer::new(buffer.channels, buffer.rate, buffer.samples.clone());
        rodio::source::UniformSourceIterator::<_, i16>::new(source, buffer.channels, output_rate)
            .collect::<Vec<_>>()
    };
    if samples.is_empty() || samples.len() % buffer.channels as usize != 0 {
        return Err("WAV could not be prepared for MP3 encoding".to_string());
    }

    let mut encoder = rusty_mp3::Mp3Encoder::new(rusty_mp3::Mp3EncoderConfig {
        bitrate_kbps: 320,
        vbr_quality: None,
    });
    encoder
        .push_pcm_s16(&samples, buffer.channels, output_rate)
        .map_err(|error| format!("cannot encode MP3 audio: {error}"))?;
    encoder.finish();

    let mut encoded = Vec::new();
    loop {
        match encoder.next_packet() {
            Ok(packet) => encoded.extend_from_slice(&packet),
            Err(rusty_mp3::Error::Eof) => break,
            Err(rusty_mp3::Error::Again) => {
                return Err("MP3 encoder needs more samples after flush".to_string());
            }
            Err(error) => return Err(format!("cannot finish MP3 encoding: {error}")),
        }
    }
    if encoded.is_empty() {
        return Err("MP3 encoder returned an empty file".to_string());
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, channels: u16, seconds: usize) -> LoopBuffer {
        let frames = rate as usize * seconds;
        let mut samples = Vec::with_capacity(frames * channels as usize);
        for frame in 0..frames {
            let value = ((frame as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin()
                * 12_000.0) as i16;
            for _ in 0..channels {
                samples.push(value);
            }
        }
        LoopBuffer {
            samples,
            channels,
            rate,
        }
    }

    #[test]
    fn converts_wav_pcm_to_decodable_320k_mp3() {
        let encoded = wav_pcm_to_mp3_320(&sine(44_100, 2, 2)).unwrap();
        assert!((75_000..=85_000).contains(&encoded.len()));
        let decoded = crate::player::decode_bytes(&encoded).unwrap();
        assert_eq!(decoded.rate, 44_100);
        assert_eq!(decoded.channels, 2);
        assert!((1_900..=2_200).contains(&decoded.duration_ms()));
    }

    #[test]
    fn resamples_supported_pcm_rates_to_mpeg1_for_320k() {
        let encoded = wav_pcm_to_mp3_320(&sine(22_050, 1, 1)).unwrap();
        let decoded = crate::player::decode_bytes(&encoded).unwrap();
        assert_eq!(decoded.rate, 44_100);
        assert_eq!(decoded.channels, 1);
        assert!((900..=1_200).contains(&decoded.duration_ms()));
    }

    #[test]
    fn rejects_multichannel_and_empty_pcm() {
        assert!(wav_pcm_to_mp3_320(&sine(44_100, 3, 1)).is_err());
        assert!(wav_pcm_to_mp3_320(&LoopBuffer {
            samples: Vec::new(),
            channels: 1,
            rate: 44_100,
        })
        .is_err());
    }
}
