/* ─────────────────────────────────────────────────────────────
   ocr-date.js — 기프티콘 사진에서 읽은 글자에서 "유효기간" 날짜 뽑아내기
   Tesseract.js가 뱉은 text를 받아 한국 기프티콘에서 흔한 표기를 해석한다.
     · 2026.12.31 / 2026-12-31 / 2026/12/31 / 2026년 12월 31일
     · 유효기간 : 2026.12.31 / 사용기한 2026. 12. 31
     · ~26.12.31 / 26.12.31 까지 / 교환기간 2026.12.01 ~ 2026.12.31
   날짜가 여러 개면 '유효기간·교환기간·기한·까지' 같은 표지 근처에 있는 날짜,
   기간(~)의 끝 날짜, 그리고 미래 날짜를 우선 고른다.
   ───────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var STRONG = [
    '유효기간', '사용기간', '사용기한', '교환기간', '교환기한', '유효일', '만료일', '사용만료'
  ];
  var WEAK = ['까지', '기한', '유효', '교환', '만료', '사용가능', 'usable', 'expire'];

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Tesseract는 한국어를 "유 효 기 간"처럼 띄어 읽기도 한다 → 글자 사이 공백을 허용한 정규식
  function looseRe(keyword) {
    var chars = keyword.replace(/\s+/g, '').split('');
    return new RegExp(chars.map(escRe).join('\\s*'), 'g');
  }

  var STRONG_RE = STRONG.map(looseRe);
  var WEAK_RE = WEAK.map(looseRe);

  function anyMatch(list, text) {
    return list.some(function (re) { re.lastIndex = 0; return re.test(text); });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function normalize(raw) {
    if (!raw) return '';
    var t = String(raw);
    // 전각 숫자·기호 → 반각
    t = t.replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    t = t.replace(/[·・⋅∙]/g, '.');
    t = t.replace(/[‐‑‒–—―ㅡ]/g, '-');
    t = t.replace(/[〜∼~]/g, '~');
    t = t.replace(/[：]/g, ':');
    t = t.replace(/[년]/g, '년').replace(/[월]/g, '월').replace(/[일]/g, '일');
    t = t.replace(/[\r\n\t]+/g, ' ');
    t = t.replace(/\s{2,}/g, ' ');
    return t;
  }

  function validDate(y, m, d) {
    if (!(y >= 2015 && y <= 2045)) return null;
    if (!(m >= 1 && m <= 12)) return null;
    if (!(d >= 1 && d <= 31)) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function toISO(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  function collect(text, todayDate) {
    var out = [];
    var spans = [];

    function push(y, m, d, index, endIndex, yearExplicit, len) {
      var dt = validDate(y, m, d);
      if (!dt) return;
      out.push({
        y: y, m: m, d: d, dt: dt,
        index: index, endIndex: endIndex,
        yearExplicit: yearExplicit,
        iso: toISO(y, m, d),
        matched: text.slice(index, endIndex).trim()
      });
      spans.push([index, endIndex]);
    }

    function overlaps(a, b) {
      for (var i = 0; i < spans.length; i++) {
        if (a < spans[i][1] && b > spans[i][0]) return true;
      }
      return false;
    }

    var m4;

    // ① 4자리 연도: 2026.12.31 / 2026-12-31 / 2026/12/31 / 2026년 12월 31일 / 2026,12,31
    var re4 = /(^|[^\d])((?:19|20)\d{2})\s*[.\-\/년,월]\s*(\d{1,2})\s*[.\-\/일월,]\s*(\d{1,2})(?!\d)/g;
    while ((m4 = re4.exec(text)) !== null) {
      var s4 = m4.index + m4[1].length;
      push(+m4[2], +m4[3], +m4[4], s4, m4.index + m4[0].length, true);
    }

    // ② 4자리 연도 + 공백 구분: 2026 12 31
    var re4s = /(^|[^\d])((?:19|20)\d{2})\s+(\d{1,2})\s+(\d{1,2})(?!\d)/g;
    while ((m4 = re4s.exec(text)) !== null) {
      var s4s = m4.index + m4[1].length;
      if (overlaps(s4s, m4.index + m4[0].length)) continue;
      push(+m4[2], +m4[3], +m4[4], s4s, m4.index + m4[0].length, true);
    }

    // ③ 2자리 연도: 26.12.31 / 26-12-31 / 26년 12월 31일
    var re2 = /(^|[^\d])(\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/일월]\s*(\d{1,2})(?!\d)/g;
    while ((m4 = re2.exec(text)) !== null) {
      var s2 = m4.index + m4[1].length;
      if (overlaps(s2, m4.index + m4[0].length)) continue;
      var yy = +m4[2];
      // 20~45 → 2020년대~2040년대
      push(2000 + yy, +m4[3], +m4[4], s2, m4.index + m4[0].length, false);
    }

    // ④ 연도 없는 월.일: 12.31 (표지 근처일 때만 채택)
    var reMD = /(^|[^\d])(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?!\d)/g;
    while ((m4 = reMD.exec(text)) !== null) {
      var smd = m4.index + m4[1].length;
      if (overlaps(smd, m4.index + m4[0].length)) continue;
      var mm = +m4[2], dd = +m4[3];
      if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) continue;
      // 올해로 두었을 때 이미 지났으면 내년으로 (연말 기프티콘 대비)
      var yThis = todayDate.getFullYear();
      var cand = new Date(yThis, mm - 1, dd);
      if (cand < todayDate) cand = new Date(yThis + 1, mm - 1, dd);
      var iso = toISO(cand.getFullYear(), mm, dd);
      out.push({
        y: cand.getFullYear(), m: mm, d: dd, dt: cand,
        index: smd, endIndex: m4.index + m4[0].length,
        yearExplicit: false, guessedYear: true,
        iso: iso, matched: m4[0].slice(m4[1].length).trim()
      });
      spans.push([smd, m4.index + m4[0].length]);
    }

    return out;
  }

  function findKeywordBefore(text, index) {
    var best = { kind: null, dist: 999 };
    var winStart = Math.max(0, index - 30);
    var win = text.slice(winStart, index).toLowerCase();

    STRONG_RE.forEach(function (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(win)) !== null) {
        var dist = win.length - (m.index + m[0].length);
        if (best.kind !== 'strong' || dist < best.dist) { best = { kind: 'strong', dist: dist }; }
        if (!m[0].length) break;
      }
    });
    if (best.kind === 'strong') return best;

    WEAK_RE.forEach(function (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(win)) !== null) {
        var dist = win.length - (m.index + m[0].length);
        if (!best.kind || dist < best.dist) { best = { kind: 'weak', dist: dist }; }
        if (!m[0].length) break;
      }
    });
    return best;
  }

  function hasRangeBefore(text, index) {
    // 앞쪽 8글자 안에 ~ 가 있으면 "기간의 끝 날짜"로 본다
    var win = text.slice(Math.max(0, index - 8), index);
    return /~/.test(win);
  }

  function parseExpiry(rawText, now) {
    var today = now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : (function () {
      var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    })();

    var text = normalize(rawText);
    if (!text) return null;

    var lower = text.toLowerCase();
    var anyStrong = anyMatch(STRONG_RE, lower);
    var anyWeak = anyMatch(WEAK_RE, lower);

    var cands = collect(text, today);
    if (!cands.length) return null;

    // 미래 후보 중 가장 늦은 날짜(표지가 전혀 없을 때 가산)
    var latestFuture = null;
    cands.forEach(function (c) {
      if (c.dt >= today && (!latestFuture || c.dt > latestFuture)) latestFuture = c.dt;
    });

    var scored = cands.map(function (c) {
      var score = 10;
      var kw = findKeywordBefore(text, c.index);
      var nearAfter = text.slice(c.endIndex, c.endIndex + 8);

      if (kw.kind === 'strong') score += Math.max(24, 46 - kw.dist * 0.7);
      else if (kw.kind === 'weak') score += Math.max(6, 18 - kw.dist * 0.5);

      if (/^\s*까\s*지/.test(nearAfter) || /^\s*일/.test(nearAfter) || /23\s*:\s*59/.test(nearAfter)) score += 9;
      if (hasRangeBefore(text, c.index)) score += 30;

      // "1.25L", "500ml", "3개" 처럼 단위가 붙은 숫자는 날짜가 아니다
      if (/^\s*(?:L|ℓ|ml|mL|ML|kg|KG|g|G|cm|mm|개|매|원|%|호)/.test(nearAfter)) score -= 30;
      if (/[+x×]$/.test(text.slice(Math.max(0, c.index - 3), c.index))) score -= 10;

      score += c.dt >= today ? 8 : -8;
      if (c.yearExplicit) score += 6;
      if (c.guessedYear) score -= 8;

      // 표지 키워드가 아예 없을 때는 가장 늦은 미래 날짜(=유효기간일 가능성)를 살짝 우대
      if (!anyStrong && !anyWeak && latestFuture && c.dt.getTime() === latestFuture.getTime()) score += 8;

      return { c: c, score: score, kw: kw };
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.c.index - b.c.index;
    });

    var top = scored[0];
    var source = top.kw.kind === 'strong' ? 'keyword' : (top.kw.kind === 'weak' ? 'near' : 'future');

    return {
      date: top.c.iso,
      score: Math.round(top.score * 10) / 10,
      source: source,
      matched: top.c.matched,
      candidates: scored.map(function (s) { return { date: s.c.iso, score: Math.round(s.score * 10) / 10 }; })
    };
  }

  global.parseExpiry = parseExpiry;
  global.parseExpiry.normalize = normalize;
  if (typeof module !== 'undefined' && module.exports) module.exports = parseExpiry;
})(typeof window !== 'undefined' ? window : globalThis);
