// parsers.js - self-contained PDF and DOCX text extraction for Alicia AI.
// Uses the browser's native DecompressionStream (Chrome 103+), no external libs,
// so it satisfies Manifest V3's content security policy.

function _latin1Decode(bytes) {
  var CHUNK = 0x8000;
  var out = '';
  for (var i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function _inflate(uint8, format) {
  var ds = new DecompressionStream(format);
  var writer = ds.writable.getWriter();
  writer.write(uint8);
  writer.close();
  var ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}

async function _inflateZlib(uint8) {
  // PDF FlateDecode is zlib-wrapped; fall back to raw deflate if needed.
  try {
    return await _inflate(uint8, 'deflate');
  } catch (e) {
    return await _inflate(uint8, 'deflate-raw');
  }
}

function _decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&amp;/g, '&');
}

// ---------- DOCX ----------

function _docxXmlToText(xml) {
  // Convert structural elements into capturable text nodes so order is preserved.
  xml = xml.replace(/<w:tab\b[^>]*\/?>/g, '<w:t>\t</w:t>');
  xml = xml.replace(/<w:br\b[^>]*\/?>/g, '<w:t>\n</w:t>');
  xml = xml.replace(/<w:cr\b[^>]*\/?>/g, '<w:t>\n</w:t>');
  xml = xml.replace(/<\/w:p>/g, '<w:t>\n</w:t></w:p>');

  var re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  var out = '';
  var m;
  while ((m = re.exec(xml)) !== null) {
    out += _decodeXmlEntities(m[1]);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocxText(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var dv = new DataView(arrayBuffer);

  // Locate End Of Central Directory record.
  var eocd = -1;
  var minI = Math.max(0, bytes.length - 22 - 65536);
  for (var i = bytes.length - 22; i >= minI; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a valid .docx file.');

  var cdOffset = dv.getUint32(eocd + 16, true);
  var cdCount = dv.getUint16(eocd + 10, true);
  var p = cdOffset;
  var target = null;
  var decoder = new TextDecoder();

  for (var n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var compSize = dv.getUint32(p + 20, true);
    var nameLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var commentLen = dv.getUint16(p + 32, true);
    var localOffset = dv.getUint32(p + 42, true);
    var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === 'word/document.xml') {
      target = { method: method, compSize: compSize, localOffset: localOffset };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('Could not find document text inside the .docx file.');

  var lo = target.localOffset;
  if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('Corrupt .docx (bad local header).');
  var lnameLen = dv.getUint16(lo + 26, true);
  var lextraLen = dv.getUint16(lo + 28, true);
  var dataStart = lo + 30 + lnameLen + lextraLen;
  var compData = bytes.subarray(dataStart, dataStart + target.compSize);

  var xmlBytes;
  if (target.method === 0) {
    xmlBytes = compData;
  } else if (target.method === 8) {
    xmlBytes = await _inflate(compData, 'deflate-raw');
  } else {
    throw new Error('Unsupported compression in .docx file.');
  }

  var xml = new TextDecoder('utf-8').decode(xmlBytes);
  return _docxXmlToText(xml);
}

// ---------- PDF ----------

function _pdfContentToText(cs) {
  var out = '';
  var pending = [];
  var inArray = 0;
  var i = 0;
  var n = cs.length;

  function flush() {
    if (pending.length) { out += pending.join(''); pending = []; }
  }

  while (i < n) {
    var ch = cs[i];

    if (ch === '(') {
      var depth = 1;
      i++;
      var str = '';
      while (i < n && depth > 0) {
        var c = cs[i];
        if (c === '\\') {
          var nx = cs[i + 1];
          if (nx === 'n') { str += '\n'; i += 2; }
          else if (nx === 'r') { str += '\r'; i += 2; }
          else if (nx === 't') { str += '\t'; i += 2; }
          else if (nx === 'b') { str += '\b'; i += 2; }
          else if (nx === 'f') { str += '\f'; i += 2; }
          else if (nx === '(' || nx === ')' || nx === '\\') { str += nx; i += 2; }
          else if (nx === '\n') { i += 2; }
          else if (nx === '\r') { i += 2; if (cs[i] === '\n') i++; }
          else if (nx >= '0' && nx <= '7') {
            var oct = nx; i += 2; var k = 0;
            while (k < 2 && cs[i] >= '0' && cs[i] <= '7') { oct += cs[i]; i++; k++; }
            str += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else { str += nx; i += 2; }
        } else if (c === '(') { depth++; str += c; i++; }
        else if (c === ')') { depth--; if (depth > 0) str += c; i++; }
        else { str += c; i++; }
      }
      pending.push(str);
    } else if (ch === '<' && cs[i + 1] !== '<') {
      var j = cs.indexOf('>', i + 1);
      if (j < 0) { i++; continue; }
      var hex = cs.substring(i + 1, j).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2) hex += '0';
      var hs = '';
      for (var h = 0; h < hex.length; h += 2) hs += String.fromCharCode(parseInt(hex.substr(h, 2), 16));
      pending.push(hs);
      i = j + 1;
    } else if (ch === '[') { inArray++; i++; }
    else if (ch === ']') { if (inArray > 0) inArray--; i++; }
    else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      var start = i;
      if (ch === '-') i++;
      while (i < n && ((cs[i] >= '0' && cs[i] <= '9') || cs[i] === '.')) i++;
      if (inArray) {
        var num = parseFloat(cs.substring(start, i));
        if (num <= -100) pending.push(' ');
      }
    } else if (ch === 'T') {
      var op2 = cs.substr(i, 2);
      if (op2 === 'Tj' || op2 === 'TJ') { flush(); i += 2; }
      else if (op2 === 'Td' || op2 === 'TD' || op2 === 'T*') { flush(); out += '\n'; i += 2; }
      else i++;
    } else if (ch === "'" || ch === '"') { flush(); out += '\n'; i++; }
    else { i++; }
  }
  flush();
  return out;
}

async function extractPdfText(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var s = _latin1Decode(bytes);
  var collected = '';
  var pos = 0;

  while (true) {
    var si = s.indexOf('stream', pos);
    if (si < 0) break;
    if (si >= 3 && s.substr(si - 3, 3) === 'end') { pos = si + 6; continue; }

    var dictStart = s.lastIndexOf('<<', si);
    var dict = dictStart >= 0 ? s.substring(dictStart, si) : '';

    var ds = si + 6;
    if (s[ds] === '\r') ds++;
    if (s[ds] === '\n') ds++;
    var ei = s.indexOf('endstream', ds);
    if (ei < 0) break;

    var streamBytes = bytes.subarray(ds, ei);
    pos = ei + 9;

    var content = null;
    if (dict.indexOf('FlateDecode') >= 0) {
      try { content = await _inflateZlib(streamBytes); } catch (e) { content = null; }
    } else if (dict.indexOf('/Filter') < 0) {
      content = streamBytes;
    }
    if (!content) continue;

    var cs = _latin1Decode(content);
    if (cs.indexOf('Tj') >= 0 || cs.indexOf('TJ') >= 0) {
      collected += _pdfContentToText(cs) + '\n';
    }
  }

  return collected.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
