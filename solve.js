// A fast csv-reader 1.0.0-compatible CSV reader.
//
// run(input) answers {columns, rows, errors} for one case's input {text, header},
// byte-identical to what csv-reader 1.0.0 returns for the same input, on every
// edge case the reference defines: a U+FEFF dropped at the very start, records
// ending at LF or CRLF, empty lines holding no record, a CR outside quotes that
// is not followed by LF dropped as stray_cr, quoted fields running to the next
// quote that is not doubled ("" inside is one quote, each CRLF or lone CR inside
// is read as LF), junk after a closing quote appended as it stands (quote_junk),
// a quote that never closes read as a literal with the rest re-read as unquoted
// (unterminated_quote), quotes inside unquoted fields literal, fields kept as
// strings, rows padded (short_row) or cut (long_row) to the first record's width,
// and every error {code, line, row} in the order met, line the 1-based line its
// record starts on and row its index in rows (null for the header).
//
// Speed: the reference walks the text one character at a time, appending one
// character at a time. This reader instead cuts each field out of the text in
// one slice: it finds the next comma or line break with String#indexOf (a native
// scan that stops at the first delimiter), slices the field whole, and only
// walks characters on the rare paths that need it (a stray CR inside an
// unquoted field, a line break or doubled quote inside a quoted field). No
// per-character work happens on the common path, and no regular expressions,
// no extra passes over the text, and no allocation beyond the field strings,
// the record arrays, and the error objects the answer itself holds. Most
// records hold no quote at all, so their first line break ends them: those are
// sliced whole and split on commas in one native call, instead of field by
// field.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // What the field reader last read: its value, how it ended, and how many
  // characters it kept (for quote_junk: only the junk after a closing quote counts).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `init` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets fValue, fEnded, fAdded.
  // The field runs to the next comma, so one slice to that comma covers it
  // whole: a line break inside that slice ends the field there instead, and a
  // CR inside the field can only be a stray one (a CRLF's LF would be the
  // nearer delimiter, and a CRLF at the field's end is trimmed first).
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    const ci = text.indexOf(',', pos);
    let seg;
    let kind;
    let endPos;
    if (ci === -1) {
      const ni = text.indexOf('\n', pos);
      if (ni === -1) {
        seg = text.slice(pos);
        kind = END;
        endPos = len;
      } else {
        seg = text.slice(pos, ni);
        kind = LINE_BREAK;
        endPos = ni + 1;
      }
    } else {
      seg = text.slice(pos, ci);
      const ni = seg.indexOf('\n');
      if (ni === -1) {
        kind = COMMA;
        endPos = ci + 1;
      } else {
        seg = seg.slice(0, ni);
        kind = LINE_BREAK;
        endPos = pos + ni + 1;
      }
    }
    let fieldLen = seg.length;
    if (kind === LINE_BREAK && fieldLen > 0 && seg.charCodeAt(fieldLen - 1) === 13) fieldLen -= 1;
    if (fieldLen > 0) {
      const f = fieldLen === seg.length ? seg : seg.slice(0, fieldLen);
      if (f.indexOf('\r') === -1) {
        value += f;
        added += f.length;
      } else {
        // Rare: stray CRs inside the field. Drop each, one stray_cr error each.
        let acc = '';
        let s = 0;
        for (let i = 0; i < f.length; i++) {
          if (f.charCodeAt(i) === 13) {
            acc += f.slice(s, i);
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            s = i + 1;
          }
        }
        acc += f.slice(s);
        value += acc;
        added += acc.length;
      }
    }
    if (kind === LINE_BREAK) line += 1;
    pos = endPos;
    fEnded = kind;
    fValue = value;
    fAdded = added;
  }

  // Reads a quoted field's body with each CRLF or lone CR turned into one LF,
  // counting lines as it goes. Only called on a segment that holds a line
  // break, so the common quoted field never pays for this walk.
  function normalizeBreaks(seg) {
    let out = '';
    let s = 0;
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charCodeAt(i);
      if (ch === 13) {
        out += seg.slice(s, i);
        out += '\n';
        line += 1;
        if (seg.charCodeAt(i + 1) === 10) i += 1;
        s = i + 1;
      } else if (ch === 10) {
        out += seg.slice(s, i);
        out += '\n';
        line += 1;
        s = i + 1;
      }
    }
    out += seg.slice(s);
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded, fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. Lines counted while scanning
        // the would-be field are undone by restoring openLine.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const seg = text.slice(p, q);
      const hasBreak = seg.indexOf('\n') !== -1 || seg.indexOf('\r') !== -1;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        value += hasBreak ? normalizeBreaks(seg) : seg;
        value += '"';
        p = q + 2;
        continue;
      }
      // The closing quote.
      value += hasBreak ? normalizeBreaks(seg) : seg;
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    let quoted = false;
    // Fast path: a record with no quote in it ends at its first line break,
    // so it can be sliced whole and split on commas in one native call. A
    // quote anywhere before that break means a quoted field may span it (or a
    // quote sits in an unquoted field), and a CR anywhere but the CRLF at its
    // end is a stray one: both fall back to the field-by-field reader.
    const nl = text.indexOf('\n', pos);
    const recEnd = nl === -1 ? len : nl;
    let bodyEnd = recEnd;
    if (nl !== -1 && recEnd > pos && text.charCodeAt(recEnd - 1) === 13) bodyEnd = recEnd - 1;
    const seg = text.slice(pos, bodyEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      if (nl === -1) pos = len;
      else {
        pos = nl + 1;
        line += 1;
      }
    } else {
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fValue);
      } while (fEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
