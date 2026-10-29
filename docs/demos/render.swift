// Renders a sanitised cast (capture.ts) into PNG frames + an ffconcat list.
// Usage: swiftc -O render.swift -o render && ./render CAST.jsonl CAPTIONS.json OUTDIR LABEL
// LABEL is printed in the top bar of every frame (e.g. the replay/live label).
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

var W = 900, H = 600, TOP = 38, FOOT = 68, PAD = 18, LH = 21, ASC = 14, CAPLH = 21
var cols = 86, capCols = 84
let bg = CGColor(red: 0.051, green: 0.067, blue: 0.09, alpha: 1)
func rgb(_ r: Double, _ g: Double, _ b: Double) -> CGColor { CGColor(red: r, green: g, blue: b, alpha: 1) }
let fg = rgb(0.90, 0.93, 0.95), green = rgb(0.25, 0.73, 0.31), amber = rgb(0.88, 0.62, 0.13)
let blue = rgb(0.35, 0.65, 1), gray = rgb(0.55, 0.58, 0.62), dark = rgb(0.09, 0.11, 0.14)
var font = CTFontCreateWithName("Menlo" as CFString, 16, nil)
var fontB = CTFontCreateWithName("Menlo-Bold" as CFString, 16, nil)
var fontS = CTFontCreateWithName("Menlo" as CFString, 12.5, nil)
var fontCap = CTFontCreateWithName("Menlo-Bold" as CFString, 16, nil)

struct Seg { let t: String; let c: CGColor; var bold = false; var cap = false }
typealias Line = [Seg]

func wrap(_ s: String, _ n: Int, indent: Int = 0) -> [String] {
  // Break at the last space or comma before the limit when there is one.
  var out: [String] = [], rest = Array(s)
  var pad = ""
  while rest.count + pad.count > n {
    let room = n - pad.count
    var cut = room
    if let i = rest[0..<room].lastIndex(where: { $0 == " " || $0 == "," }), i > room / 2 { cut = i + 1 }
    out.append(pad + String(rest[0..<cut]))
    rest = Array(rest[cut...]); pad = String(repeating: " ", count: indent)
  }
  out.append(pad + String(rest))
  return out
}

func cmdLines(_ text: String) -> [Line] {
  // "$ " prompt, 'relay' blue, '--peer NAME' name amber, rest fg. Wrapped.
  let rows = wrap("$ " + text, cols, indent: 4)
  return rows.map { row in
    var segs: Line = []
    let tokens = row.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    var prevPeer = false
    for (i, t) in tokens.enumerated() {
      let sep = i == 0 ? "" : " "
      var c = fg, b = false
      if t == "$" { c = gray } else if t == "relay" { c = blue; b = true }
      else if t == "--peer" { c = gray; prevPeer = true }
      else if prevPeer { c = amber; b = true; prevPeer = false }
      else if t.hasPrefix("--") { c = gray }
      segs.append(Seg(t: sep + t, c: c, bold: b))
    }
    return segs
  }
}
func outLines(_ text: String, rc: Int) -> [Line] {
  wrap(text, cols - 2, indent: 2).map { [Seg(t: "  " + $0.trimmingCharacters(in: .init(charactersIn: "\n")), c: rc == 0 ? green : rgb(0.97, 0.32, 0.29))] }
}

func ctx() -> CGContext {
  CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func draw(_ g: CGContext, _ segs: Line, x: Double, yTop: Double, small: Bool = false) {
  var x = x
  for s in segs {
    let f = small ? fontS : (s.cap ? fontCap : (s.bold ? fontB : font))
    let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): f, NSAttributedString.Key(kCTForegroundColorAttributeName as String): s.c]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s.t, attributes: attrs))
    g.textPosition = CGPoint(x: x, y: Double(H) - yTop - Double(ASC))
    CTLineDraw(line, g)
    x += CTLineGetTypographicBounds(line, nil, nil, nil)
  }
}
func fill(_ g: CGContext, _ c: CGColor, _ r: CGRect) { g.setFillColor(c); g.fill(r) }
func png(_ g: CGContext, _ path: String) {
  let url = URL(fileURLWithPath: path) as CFURL
  let d = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, g.makeImage()!, nil); CGImageDestinationFinalize(d)
}

var summary = false
var footer = "private temp state, namespace showcase, IDs shown as aliases, --state/--namespace omitted"
func frame(_ path: String, label: String, lines: [Line], caption: String, host: Bool = false, center: [String]? = nil) {
  let g = ctx()
  fill(g, bg, CGRect(x: 0, y: 0, width: W, height: H))
  fill(g, dark, CGRect(x: 0, y: H - TOP, width: W, height: TOP))
  for (i, part) in label.components(separatedBy: "|").enumerated() { draw(g, [Seg(t: part.trimmingCharacters(in: .whitespaces), c: amber, bold: true)], x: Double(PAD), yTop: Double(10 + i * (LH - 2))) }
  let rows = (H - TOP - FOOT - PAD) / LH
  if let c = center {
    var y = 170.0
    for (i, t) in c.enumerated() {
      // Wrap each intro line to the width left of the indent so nothing is cut off.
      for row in (t.isEmpty ? [""] : wrap(t, cols - 3)) {
        draw(g, [Seg(t: row, c: i == 0 ? fg : gray, bold: i == 0)], x: Double(PAD + 20), yTop: y); y += 32
      }
      y += 8
    }
  } else {
    for (i, l) in lines.suffix(rows).enumerated() { draw(g, l, x: Double(PAD), yTop: Double(TOP + 10 + i * LH)) }
  }
  fill(g, dark, CGRect(x: 0, y: 0, width: W, height: FOOT))
  let c = host ? amber : fg
  for (i, t) in wrap(caption, capCols).prefix(summary ? 3 : 2).enumerated() {
    draw(g, [Seg(t: t, c: c, bold: true, cap: summary)], x: Double(PAD), yTop: Double(H - FOOT + 8 + i * CAPLH))
  }
  draw(g, [Seg(t: footer, c: gray)],
       x: Double(PAD), yTop: Double(H - 22), small: true)
  png(g, path)
}

// ---- main ----
let a = CommandLine.arguments
guard a.count >= 5 else { print("usage: render CAST CAPTIONS OUTDIR LABEL"); exit(2) }
let out = a[3], label = a[4]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
let cfg = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[2]))) as! [String: Any]
let caps = (cfg["captions"] as! [[String: String]])
if let f = cfg["footer"] as? String { footer = f }
if (cfg["style"] as? String) == "summary" {
  summary = true; W = 720; H = 760; TOP = 68; FOOT = 112; PAD = 18; LH = 30; ASC = 20; CAPLH = 25; cols = 51; capCols = 58
  font = CTFontCreateWithName("Menlo" as CFString, 22, nil); fontB = CTFontCreateWithName("Menlo-Bold" as CFString, 22, nil)
  fontS = CTFontCreateWithName("Menlo" as CFString, 13, nil); fontCap = CTFontCreateWithName("Menlo-Bold" as CFString, 19, nil)
}
let intro = cfg["intro"] as! [String], outro = cfg["outro"] as! String
let events = try! String(contentsOfFile: a[1], encoding: .utf8).split(separator: "\n")
  .map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }

var n = 0, list = "ffconcat version 1.0\n", last = ""
func emit(_ lines: [Line], _ cap: String, _ dur: Double, host: Bool = false, center: [String]? = nil) {
  let p = String(format: "%@/f%03d.png", out, n); n += 1
  frame(p, label: label, lines: lines, caption: cap, host: host, center: center)
  list += "file 'f\(String(format: "%03d", n - 1)).png'\nduration \(dur)\n"; last = p
}
emit([], "", 2.2, center: [intro[0], intro[1], "", "Real command output, sanitised. See docs/demos/README.md."])
var buf: [Line] = []
let tone: [String: (CGColor, Bool)] = ["alias-claude": (rgb(0.90, 0.52, 0.38), true), "alias-codex": (rgb(0.40, 0.80, 0.90), true),
  "dim": (gray, false), "ok": (green, false), "warn": (amber, true), "host": (amber, true), "text": (fg, false), "quote": (gray, false)]
for e in events where (e["kind"] as! String) != "meta" {
  if summary, let ls = e["lines"] as? [[String]] {
    let isHost = (e["kind"] as! String) == "host"
    let text = e["text"] as! String
    let cap = isHost ? "Host side: the T3 task API started this agent, recorded from returned task metadata. Relay never starts agents."
      : (caps.first { (text + " " + ((e["out"] as? String) ?? "")).contains($0["match"]!) }?["caption"] ?? "")
    buf += ls.enumerated().map { (i, l) in
      let t = tone[l[1]] ?? (fg, false)
      return [Seg(t: (i == 0 || isHost ? "" : "  ") + l[0], c: t.0, bold: t.1)]
    }
    emit(buf, cap, max(1.4, min(2.8, 0.8 + 0.02 * Double(cap.count))), host: isHost)
    continue
  }
  if (e["kind"] as! String) == "host" {
    let ht = e["text"] as! String
    let live = ht.hasPrefix("HOST")
    buf += wrap("# " + (live ? ht : "HOST step (marker, not Relay): " + ht), cols, indent: 2).map { [Seg(t: $0, c: amber, bold: true)] }
    emit(buf, live ? "Host side: the T3 task API started this agent (recorded from returned task metadata). Relay never starts agents." : "Marker only: in real use the host runtime does this. Relay never starts agents.", 1.8, host: true)
    continue
  }
  let text = e["text"] as! String, o = e["out"] as! String, rc = e["rc"] as! Int
  let cap = caps.first { text.contains($0["match"]!) }?["caption"] ?? ""
  buf += cmdLines(text); emit(buf, "", 0.4)
  buf += outLines(o, rc: rc); emit(buf, cap, max(cap.isEmpty ? 0.7 : 1.2, min(2.3, 0.5 + 0.004 * Double(o.count) + Double(cap.count) * 0.02)))
}
emit(buf, outro, 3.0)
try! list.write(toFile: out + "/list.ffconcat", atomically: true, encoding: .utf8)
try! FileManager.default.copyItem(atPath: last, toPath: out + "/poster.png")
print("frames:", n)
