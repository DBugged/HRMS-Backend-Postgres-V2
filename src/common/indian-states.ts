// Canonical spellings of India's states and union territories — the one list used wherever a record is tied to a
// state for statutory purposes (a Work Location's state, and the state-wise Labour Welfare Fund rates that are
// matched against it). Matching is by exact name, so both sides must draw from this list.
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];

// This phase targets Maharashtra only: an organization's state, a Work Location's state and state-wise PT/LWF rates
// must be one of these. To open the product to more states later, add them here (and to SUPPORTED_STATES in the
// frontend's constants/indianStates.ts) — the state-wise engine itself already handles any state.
export const SUPPORTED_STATES: readonly string[] = ['Maharashtra'];

export function isSupportedState(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_STATES.includes(value);
}

export function isIndianState(value: unknown): value is IndianState {
  return (
    typeof value === 'string' &&
    (INDIAN_STATES as readonly string[]).includes(value)
  );
}
