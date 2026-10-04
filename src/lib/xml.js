/**
 * xml.js
 *
 * Small XML helpers shared by the report parsers.
 */

const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

export function decodeXmlEntities(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#([0-9]+);/g, (_, decimal) => {
      try {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      } catch {
        return '';
      }
    })
    .replace(/&amp;/g, '&');
}

/**
 * TCV-7070: read XML element text while keeping CDATA content literal.
 * Text outside CDATA remains entity-encoded and must be decoded.
 */
export function decodeXmlText(value) {
  const raw = value === undefined || value === null ? '' : String(value);
  let decoded = '';
  let cursor = 0;
  let section;

  CDATA_PATTERN.lastIndex = 0;
  while ((section = CDATA_PATTERN.exec(raw)) !== null) {
    decoded += decodeXmlEntities(raw.slice(cursor, section.index));
    decoded += section[1];
    cursor = CDATA_PATTERN.lastIndex;
  }
  decoded += decodeXmlEntities(raw.slice(cursor));

  return decoded;
}
