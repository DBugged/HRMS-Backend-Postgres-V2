// Purpose: refuse "<" and ">" (and control characters) in free-text names, so markup such as <script> can never be stored as a
//   company, department or similar name. Ordinary business punctuation (& / ( ) , . ' - # @ +) is allowed.
// Important: this guards what is stored; the screens also escape text when drawing it.
import { Matches } from 'class-validator';

const NO_MARKUP = /^[^<>\p{Cc}]*$/u;

export function NoMarkup(label: string) {
  return Matches(NO_MARKUP, { message: `${label} must not contain the characters < or >.` });
}

// 24-hour time of day, "09:30".
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function IsTimeOfDay(label: string) {
  return Matches(HHMM, { message: `${label} must be a time in 24-hour HH:MM format, for example 09:30.` });
}
