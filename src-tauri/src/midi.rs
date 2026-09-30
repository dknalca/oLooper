//! MIDI input discovery and discrete Note On / Control Change events.

use std::collections::{HashMap, HashSet};

use midir::{Ignore, MidiInput, MidiInputConnection, MidiInputPort};
use serde::Serialize;
use tauri::Emitter as _;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInputInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiMessage {
    pub input_id: String,
    pub input_name: String,
    /// "note" or "cc". CC is emitted only on a discrete 0 -> nonzero press.
    pub kind: MidiMessageKind,
    /// One-based MIDI channel (1–16).
    pub channel: u8,
    /// Note number or CC number (0–127).
    pub number: u8,
    pub value: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MidiMessageKind {
    Note,
    Cc,
}

enum ParsedMidiMessage {
    Press(MidiMessage),
    CcRelease { channel: u8, number: u8 },
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
        0xb0 => return Some(ParsedMidiMessage::CcRelease { channel, number }),
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

fn take_discrete_press(
    parsed: Option<ParsedMidiMessage>,
    active_cc: &mut HashSet<(u8, u8)>,
) -> Option<MidiMessage> {
    match parsed? {
        ParsedMidiMessage::CcRelease { channel, number } => {
            active_cc.remove(&(channel, number));
            None
        }
        ParsedMidiMessage::Press(message) => {
            if message.kind == MidiMessageKind::Cc
                && !active_cc.insert((message.channel, message.number))
            {
                return None;
            }
            Some(message)
        }
    }
}

#[derive(Default)]
pub struct MidiManager {
    connection: Option<MidiInputConnection<()>>,
    connected: Option<MidiInputInfo>,
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
        let mut active_cc = HashSet::<(u8, u8)>::new();
        let connection = input
            .connect(
                &port,
                "olooper-midi-input",
                move |_timestamp, bytes, _| match parse_message(&callback_info, bytes) {
                    parsed => {
                        if let Some(message) = take_discrete_press(parsed, &mut active_cc) {
                            let _ = app.emit("olooper:midi-message", message);
                        }
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
            Some(ParsedMidiMessage::CcRelease {
                channel: 5,
                number: 7
            })
        ));
    }

    #[test]
    fn cc_repeated_nonzero_values_emit_once_until_zero_rearms() {
        let input = test_input();
        let mut active_cc = HashSet::new();

        assert!(
            take_discrete_press(parse_message(&input, &[0xb4, 7, 127]), &mut active_cc).is_some()
        );
        assert!(
            take_discrete_press(parse_message(&input, &[0xb4, 7, 64]), &mut active_cc).is_none()
        );
        assert!(
            take_discrete_press(parse_message(&input, &[0xb4, 7, 0]), &mut active_cc).is_none()
        );
        assert!(
            take_discrete_press(parse_message(&input, &[0xb4, 7, 1]), &mut active_cc).is_some()
        );
    }

    #[test]
    fn ignores_malformed_and_unmapped_midi_messages() {
        let input = test_input();
        assert!(parse_message(&input, &[0x90, 60]).is_none());
        assert!(parse_message(&input, &[0xe0, 0, 64]).is_none());
    }
}
