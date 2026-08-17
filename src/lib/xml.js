/**
 * xml.js
 *
 * Small XML helpers shared by the report parsers.
 */

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
