//! MIDI input discovery and discrete Note On / Control Change events.

use std::collections::HashMap;

use midir::{
    Ignore, MidiInput, MidiInputConnection, MidiInputPort, MidiOutput, MidiOutputConnection,
};
use serde::Serialize;
use tauri::Emitter as _;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInputInfo {
    pub id: String,
    pub name: String,
}

pub type MidiOutputInfo = MidiInputInfo;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiMessage {
    pub input_id: String,
    pub input_name: String,
    /// "note" or "cc". CC messages include their raw value, including zero releases.
    pub kind: MidiMessageKind,
    /// One-based MIDI channel (1–16).
    pub channel: u8,
    /// Note number or CC number (0–127).
    pub number: u8,
    pub value: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiLedBinding {
    pub kind: MidiMessageKind,
    pub channel: u8,
    pub number: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MidiMessageKind {
    Note,
    Cc,
}

enum ParsedMidiMessage {
    Press(MidiMessage),
    CcRelease(MidiMessage),
}

fn parse_message(input: &MidiInputInfo, bytes: &[u8]) -> Option<ParsedMidiMessage> {
    if bytes.len() < 3 {
        return None;
    }
    let status = bytes[0] & 0xf0;
    let channel = (bytes[0] & 0x0f) + 1;
    let number = bytes[1] & 0x7f;
    let value = bytes[2] & 0x7f;
    let kind = match status {
        // Note On with velocity zero is a MIDI Note Off.
        0x90 if value > 0 => MidiMessageKind::Note,
        0xb0 if value > 0 => MidiMessageKind::Cc,
        0xb0 => {
            return Some(ParsedMidiMessage::CcRelease(MidiMessage {
                input_id: input.id.clone(),
                input_name: input.name.clone(),
                kind: MidiMessageKind::Cc,
                channel,
                number,
                value,
            }))
        }
        _ => return None,
    };
    Some(ParsedMidiMessage::Press(MidiMessage {
        input_id: input.id.clone(),
        input_name: input.name.clone(),
        kind,
        channel,
        number,
        value,
    }))
}

fn parsed_message(parsed: Option<ParsedMidiMessage>) -> Option<MidiMessage> {
    match parsed? {
        ParsedMidiMessage::CcRelease(message) | ParsedMidiMessage::Press(message) => Some(message),
    }
}

#[derive(Default)]
pub struct MidiManager {
    connection: Option<MidiInputConnection<()>>,
    connected: Option<MidiInputInfo>,
    output: Option<MidiOutputConnection>,
    connected_output: Option<MidiOutputInfo>,
    active_leds: HashMap<(MidiMessageKind, u8, u8), MidiLedBinding>,
}

fn outputs_with_info(
    output: &MidiOutput,
) -> Result<Vec<(midir::MidiOutputPort, MidiOutputInfo)>, String> {
    let mut occurrences = HashMap::<String, usize>::new();
    output
        .ports()
        .into_iter()
        .map(|port| {
            let name = output
                .port_name(&port)
                .map_err(|error| format!("cannot read MIDI output name: {error}"))?;
            let occurrence = occurrences.entry(name.clone()).or_default();
            let info = MidiOutputInfo {
                id: format!("{name}#{occurrence}"),
                name,
            };
            *occurrence += 1;
            Ok((port, info))
        })
        .collect()
}

pub fn list_outputs() -> Result<Vec<MidiOutputInfo>, String> {
    let output = MidiOutput::new("oLooper MIDI output")
        .map_err(|error| format!("cannot initialize MIDI output: {error}"))?;
    Ok(outputs_with_info(&output)?
        .into_iter()
        .map(|(_, info)| info)
        .collect())
}

pub fn led_message(binding: &MidiLedBinding, enabled: bool) -> Result<[u8; 3], String> {
    if !(1..=16).contains(&binding.channel) || binding.number > 127 {
        return Err("invalid MIDI LED binding".to_string());
    }
    let status = match binding.kind {
        MidiMessageKind::Note => {
            if enabled {
                0x90
            } else {
                0x80
            }
        }
        MidiMessageKind::Cc => 0xb0,
    } | (binding.channel - 1);
    Ok([status, binding.number, if enabled { 127 } else { 0 }])
}

fn ports_with_info(input: &MidiInput) -> Result<Vec<(MidiInputPort, MidiInputInfo)>, String> {
    let mut occurrences = HashMap::<String, usize>::new();
    input
        .ports()
        .into_iter()
        .map(|port| {
            let name = input
                .port_name(&port)
                .map_err(|error| format!("cannot read MIDI input name: {error}"))?;
            let occurrence = occurrences.entry(name.clone()).or_default();
            let info = MidiInputInfo {
                id: format!("{name}#{occurrence}"),
                name,
            };
            *occurrence += 1;
            Ok((port, info))
        })
        .collect()
}

pub fn list_inputs() -> Result<Vec<MidiInputInfo>, String> {
    let input = MidiInput::new("oLooper MIDI")
        .map_err(|error| format!("cannot initialize MIDI input: {error}"))?;
    Ok(ports_with_info(&input)?
        .into_iter()
        .map(|(_, info)| info)
        .collect())
}

impl MidiManager {
    pub fn connected_input(&self) -> Option<MidiInputInfo> {
        self.connected.clone()
    }

    pub fn disconnect(&mut self) {
        self.connection = None;
        self.connected = None;
    }

    pub fn connected_output(&self) -> Option<MidiOutputInfo> {
        self.connected_output.clone()
    }

    pub fn disconnect_output(&mut self) {
        if let Some(output) = self.output.as_mut() {
            for binding in self.active_leds.values() {
                if let Ok(message) = led_message(binding, false) {
                    let _ = output.send(&message);
                }
            }
        }
        self.active_leds.clear();
        self.output = None;
        self.connected_output = None;
    }

    pub fn connect_output(&mut self, output_id: &str) -> Result<MidiOutputInfo, String> {
        self.disconnect_output();
        let output = MidiOutput::new("oLooper MIDI output")
            .map_err(|error| format!("cannot initialize MIDI output: {error}"))?;
        let (port, info) = outputs_with_info(&output)?
            .into_iter()
            .find(|(_, info)| info.id == output_id)
            .ok_or_else(|| {
                "MIDI output is no longer available; refresh the device list".to_string()
            })?;
        let connection = output
            .connect(&port, "olooper-midi-feedback")
            .map_err(|error| format!("cannot connect MIDI output: {error}"))?;
        self.output = Some(connection);
        self.connected_output = Some(info.clone());
        Ok(info)
    }

    pub fn set_led(&mut self, binding: &MidiLedBinding, enabled: bool) -> Result<(), String> {
        let message = led_message(binding, enabled)?;
        let output = self
            .output
            .as_mut()
            .ok_or_else(|| "no MIDI output connected".to_string())?;
        output
            .send(&message)
            .map_err(|error| format!("cannot send MIDI pad feedback: {error}"))?;
        let key = (binding.kind, binding.channel, binding.number);
        if enabled {
            self.active_leds.insert(key, binding.clone());
        } else {
            self.active_leds.remove(&key);
        }
        Ok(())
    }

    pub fn connect(
        &mut self,
        app: &tauri::AppHandle,
        input_id: &str,
    ) -> Result<MidiInputInfo, String> {
        self.disconnect();

        let mut input = MidiInput::new("oLooper MIDI")
            .map_err(|error| format!("cannot initialize MIDI input: {error}"))?;
        input.ignore(Ignore::None);
        let (port, info) = ports_with_info(&input)?
            .into_iter()
            .find(|(_, info)| info.id == input_id)
            .ok_or_else(|| {
                "MIDI input is no longer available; refresh the device list".to_string()
            })?;

        let app = app.clone();
        let callback_info = info.clone();
        let connection = input
            .connect(
                &port,
                "olooper-midi-input",
                move |_timestamp, bytes, _| {
                    if let Some(message) = parsed_message(parse_message(&callback_info, bytes)) {
                        let _ = app.emit("olooper:midi-message", message);
                    }
                },
                (),
            )
            .map_err(|error| format!("cannot connect MIDI input: {error}"))?;

        self.connection = Some(connection);
        self.connected = Some(info.clone());
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn led_feedback_uses_discrete_note_and_cc_messages() {
        let note = MidiLedBinding {
            kind: MidiMessageKind::Note,
            channel: 2,
            number: 60,
        };
        assert_eq!(led_message(&note, true).unwrap(), [0x91, 60, 127]);
        assert_eq!(led_message(&note, false).unwrap(), [0x81, 60, 0]);
        let cc = MidiLedBinding {
            kind: MidiMessageKind::Cc,
            channel: 1,
            number: 7,
        };
        assert_eq!(led_message(&cc, true).unwrap(), [0xb0, 7, 127]);
        assert_eq!(led_message(&cc, false).unwrap(), [0xb0, 7, 0]);
    }

    #[test]
    fn led_feedback_rejects_out_of_range_addresses() {
        assert!(led_message(
            &MidiLedBinding {
                kind: MidiMessageKind::Note,
                channel: 0,
                number: 60,
            },
            true
        )
        .is_err());
    }

    fn test_input() -> MidiInputInfo {
        MidiInputInfo {
            id: "Pad Controller#0".to_string(),
            name: "Pad Controller".to_string(),
        }
    }

    #[test]
    fn parses_note_on_as_a_discrete_press() {
        let Some(ParsedMidiMessage::Press(message)) = parse_message(&test_input(), &[0x92, 60, 99])
        else {
            panic!("expected a Note On press");
        };
        assert_eq!(message.kind, MidiMessageKind::Note);
        assert_eq!(
            (message.channel, message.number, message.value),
            (3, 60, 99)
        );
    }

    #[test]
    fn ignores_note_off_and_zero_velocity_note_on() {
        assert!(parse_message(&test_input(), &[0x82, 60, 64]).is_none());
        assert!(parse_message(&test_input(), &[0x92, 60, 0]).is_none());
    }

    #[test]
    fn parses_cc_press_and_release_edges() {
        let Some(ParsedMidiMessage::Press(message)) = parse_message(&test_input(), &[0xb4, 7, 127])
        else {
            panic!("expected a CC press");
        };
        assert_eq!(message.kind, MidiMessageKind::Cc);
        assert_eq!(
            (message.channel, message.number, message.value),
            (5, 7, 127)
        );
        assert!(matches!(
            parse_message(&test_input(), &[0xb4, 7, 0]),
            Some(ParsedMidiMessage::CcRelease(MidiMessage {
                channel: 5,
                number: 7,
                value: 0,
                ..
            }))
        ));
    }

    #[test]
    fn repeated_cc_values_and_zero_release_are_forwarded() {
        let input = test_input();
        for value in [127, 127, 64, 0, 1] {
            let message = parsed_message(parse_message(&input, &[0xb4, 7, value])).unwrap();
            assert_eq!(message.value, value);
        }
    }

    #[test]
    fn ignores_malformed_and_unmapped_midi_messages() {
        let input = test_input();
        assert!(parse_message(&input, &[0x90, 60]).is_none());
        assert!(parse_message(&input, &[0xe0, 0, 64]).is_none());
    }
}
