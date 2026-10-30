/**
 * Privacy helpers for the hardware identifiers.
 *
 * The NVIDIA GPU UUID (and the PCI bus address) identify one physical board.
 * The app can hide them so that screenshots, shared screens and exported
 * reports do not carry a value that NVIDIA could use to recognise the card.
 *
 * The real value is never destroyed here: the main process still needs it to
 * talk to the driver. Only the interface stops displaying it.
 */

/** Text shown in place of an identifier when it is hidden. */
export const MASKED_HARDWARE_ID = 'oculto';

/**
 * Returns the value to display for a hardware identifier.
 *
 * When `hidden` is false the original value is returned untouched.
 */
export function displayHardwareIdentifier(
  value: string | null | undefined,
  hidden: boolean,
): string {
  if (hidden) return MASKED_HARDWARE_ID;
  return value && value.length > 0 ? value : '—';
}

/**
 * True when the identifier must not leave the interface.
 *
 * Simulated devices carry obviously synthetic UUIDs, so there is nothing to
 * hide: the value is already not a real board.
 */
export function shouldHideIdentifier(
  value: string | null | undefined,
  hidden: boolean,
  simulated: boolean,
): boolean {
  if (!hidden) return false;
  if (simulated) return false;
  // A synthetic UUID (GPU-00000000-...) is not a real board either.
  return !!value && !/^GPU-0{8}-/.test(value);
}
