// Attendees are typed as bare org usernames (e.g. "cuongdm4") in the booking
// form; the backend appends the org suffix before storing/sending full
// addresses (see `_normalize_attendees` in backend/app/main.py). When we seed
// an edit form from a stored booking we strip the suffix again so the field
// shows what the user originally typed instead of the full email.
export const ATTENDEE_EMAIL_DOMAIN = "@vng.com.vn";

/** Drop the org email suffix so "cuongdm4@vng.com.vn" displays as "cuongdm4".
 * Addresses on other domains are left untouched. */
export function stripAttendeeDomain(email: string): string {
  const value = email.trim();
  return value.toLowerCase().endsWith(ATTENDEE_EMAIL_DOMAIN)
    ? value.slice(0, -ATTENDEE_EMAIL_DOMAIN.length)
    : value;
}

/** Format a stored attendee list for the editable text field. */
export function attendeesToInput(attendees: string[] | null | undefined): string {
  return (attendees ?? [])
    .map(stripAttendeeDomain)
    .filter(Boolean)
    .join(", ");
}
