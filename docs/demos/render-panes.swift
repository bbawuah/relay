// Renders a cast of captured tmux panes (2x2) into PNG frames plus an ffconcat list.
// Input JSONL, one frame per line:
//   {"dur": 1.2, "banner": "...", "caption": "...", "panes": [{"title": "...", "ansi": "captured text with SGR escapes"}, ... x4]}
// Pane order: top-left, top-right, bottom-left, bottom-right.
// Usage: swiftc -O render-panes.swift -o render-panes && ./render-panes CAST.jsonl OUTDIR
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let COLS = 82, ROWS = 22, FS: CGFloat = 13.5, LH = 17, TITLE = 26, GAP = 8, HEAD = 40, FOOT = 56, PADX = 8
let font = CTFontCreateWithName("Menlo" as CFString, FS, nil)
let fontB = CTFontCreateWithName("Menlo-Bold" as CFString, FS, nil)
let cw = CTFontGetAdvancesForGlyphs(font, .horizontal, [CTFontGetGlyphWithName(font, "M" as CFString)], nil, 1)
let paneW = Int(cw * CGFloat(COLS)) + 2 * PADX, paneH = TITLE + ROWS * LH + 6
let W = paneW * 2 + GAP * 3, H = HEAD + paneH * 2 + GAP * 3 + FOOT
func rgb(_ r: Int, _ g: Int, _ b: Int) -> CGColor { CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1) }
let bg = rgb(13, 17, 23), panebg = rgb(22, 27, 34), fgDef = rgb(201, 209, 217), amber = rgb(224, 160, 32), bar = rgb(33, 38, 45)
let base16: [(Int, Int, Int)] = [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(204,204,204),
  (102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)]
func p256(_ n: Int) -> CGColor {
  if n < 16 { let c = base16[n]; return rgb(c.0, c.1, c.2) }
  if n < 232 { let i = n - 16; let v = [0, 95, 135, 175, 215, 255]; return rgb(v[i / 36], v[(i / 6) % 6], v[i % 6]) }
  let g = 8 + (n - 232) * 10; return rgb(g, g, g)
}
struct Style { var fg: CGColor? = nil; var bg: CGColor? = nil; var bold = false; var dim = false; var rev = false }
func parse(_ line: String) -> [(Character, Style)] {
  var out: [(Character, Style)] = [], st = Style(), i = line.startIndex
  while i < line.endIndex {
    let ch = line[i]
    if ch == "\u{1B}", line.index(after: i) < line.endIndex, line[line.index(after: i)] == "[" {
      var j = line.index(i, offsetBy: 2), params = ""
      while j < line.endIndex, !line[j].isLetter { params.append(line[j]); j = line.index(after: j) }
      if j < line.endIndex, line[j] == "m" {
        let n = params.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        var k = 0
        while k < n.count {
          let c = n[k]
          switch c {
          case 0: st = Style()
          case 1: st.bold = true
          case 2: st.dim = true
          case 22: st.bold = false; st.dim = false
          case 7: st.rev = true
          case 27: st.rev = false
          case 30...37: st.fg = p256(c - 30)
          case 90...97: st.fg = p256(c - 90 + 8)
          case 39: st.fg = nil
          case 40...47: st.bg = p256(c - 40)
          case 100...107: st.bg = p256(c - 100 + 8)
          case 49: st.bg = nil
          case 38, 48:
            if k + 2 < n.count, n[k + 1] == 5 { if c == 38 { st.fg = p256(n[k + 2]) } else { st.bg = p256(n[k + 2]) }; k += 2 }
            else if k + 4 < n.count, n[k + 1] == 2 { let col = rgb(n[k + 2], n[k + 3], n[k + 4]); if c == 38 { st.fg = col } else { st.bg = col }; k += 4 }
          default: break
          }
          k += 1
        }
      }
      i = j < line.endIndex ? line.index(after: j) : j
      continue
    }
    out.append((ch, st)); i = line.index(after: i)
  }
  return out
}
func ctx() -> CGContext {
  CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func text(_ g: CGContext, _ s: String, x: CGFloat, yTop: CGFloat, color: CGColor, bold: Bool = false, size: CGFloat? = nil) {
  let f = size != nil ? CTFontCreateWithName((bold ? "Menlo-Bold" : "Menlo") as CFString, size!, nil) : (bold ? fontB : font)
  let a: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): f, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
  let l = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: a))
  g.textPosition = CGPoint(x: x, y: CGFloat(H) - yTop - (size ?? FS) * 0.95); CTLineDraw(l, g)
}
func fillR(_ g: CGContext, _ c: CGColor, _ r: CGRect) { g.setFillColor(c); g.fill(r) }
func wrapText(_ s: String, _ n: Int) -> [String] {
  var rows: [String] = [], cur = ""
  for w in s.split(separator: " ") { if cur.count + w.count + 1 > n { rows.append(cur); cur = String(w) } else { cur += (cur.isEmpty ? "" : " ") + w } }
  if !cur.isEmpty { rows.append(cur) }; return rows
}
func render(_ f: [String: Any], _ path: String) {
  let g = ctx(); fillR(g, bg, CGRect(x: 0, y: 0, width: W, height: H))
  text(g, (f["banner"] as? String) ?? "", x: 12, yTop: 11, color: amber, bold: true, size: 15)
  let panes = f["panes"] as! [[String: Any]]
  for (idx, p) in panes.enumerated() {
    let x0 = GAP + (idx % 2) * (paneW + GAP), y0 = HEAD + GAP + (idx / 2) * (paneH + GAP)
    fillR(g, panebg, CGRect(x: x0, y: H - y0 - paneH, width: paneW, height: paneH))
    fillR(g, bar, CGRect(x: x0, y: H - y0 - TITLE, width: paneW, height: TITLE))
    text(g, (p["title"] as? String) ?? "", x: CGFloat(x0 + PADX), yTop: CGFloat(y0 + 6), color: fgDef, bold: true, size: 13)
    let lines = ((p["ansi"] as? String) ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    for (r, line) in lines.prefix(ROWS).enumerated() {
      var col = 0
      for (ch, st) in parse(line) {
        let x = CGFloat(x0 + PADX) + CGFloat(col) * cw, yT = CGFloat(y0 + TITLE + 3 + r * LH)
        var fgc = st.fg ?? fgDef, bgc = st.bg
        if st.rev { let t = fgc; fgc = bgc ?? panebg; bgc = t }
        if let b = bgc { fillR(g, b, CGRect(x: x, y: CGFloat(H) - yT - CGFloat(LH), width: cw, height: CGFloat(LH))) }
        if ch != " " {
          var c = fgc; if st.dim { c = c.copy(alpha: 0.6) ?? c }
          text(g, String(ch), x: x, yTop: yT, color: c, bold: st.bold)
        }
        col += 1; if col >= COLS { break }
      }
    }
  }
  fillR(g, bar, CGRect(x: 0, y: 0, width: W, height: FOOT))
  for (i, row) in wrapText((f["caption"] as? String) ?? "", 130).prefix(2).enumerated() { text(g, row, x: 12, yTop: CGFloat(H - FOOT + 9 + i * 20), color: fgDef, bold: true, size: 15) }
  let url = URL(fileURLWithPath: path) as CFURL
  let d = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, g.makeImage()!, nil); CGImageDestinationFinalize(d)
}
let a = CommandLine.arguments
guard a.count >= 3 else { print("usage: render-panes CAST OUTDIR"); exit(2) }
try? FileManager.default.createDirectory(atPath: a[2], withIntermediateDirectories: true)
var list = "ffconcat version 1.0\n", n = 0, last = ""
for line in try! String(contentsOfFile: a[1], encoding: .utf8).split(separator: "\n") {
  let f = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
  let p = String(format: "%@/f%04d.png", a[2], n); render(f, p)
  list += "file 'f\(String(format: "%04d", n)).png'\nduration \((f["dur"] as? Double) ?? 1.0)\n"; last = p; n += 1
}
try! list.write(toFile: a[2] + "/list.ffconcat", atomically: true, encoding: .utf8)
try? FileManager.default.removeItem(atPath: a[2] + "/poster.png")
try! FileManager.default.copyItem(atPath: last, toPath: a[2] + "/poster.png")
print("frames:", n, "size:", W, "x", H)
