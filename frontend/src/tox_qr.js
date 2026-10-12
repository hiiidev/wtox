/** Accept QR payloads representing a full Tox address (32-byte public key,
 * 4-byte nospam and 2-byte checksum). Never treat arbitrary QR content as a URL
 * or execute it. The project's own QRCode exports the plain 76-hex address.
 */
export function parseScannedToxId(value){
  if(typeof value!=="string")return null;
  const text=value.trim();
  // Some compatible Tox clients put a tox: scheme before the address.
  const match=/^(?:tox:(?:\/\/)?)?([0-9a-fA-F]{76})$/i.exec(text);
  return match?match[1].toUpperCase():null;
}
