import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// tray-driver: drive ONE running instance of the AgentBox menu-bar app through Accessibility,
// scoped by PID so the user's own tray (same executable family, different process) is never
// touched. Every command prints one JSON object on stdout; failures print {"ok":false,"error":…}
// and exit non-zero (1 = not found / failed check, 2 = usage or environment error).

// MARK: - Output

func emit(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
        ?? Data(#"{"ok":false,"error":"unserializable output"}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String, code: Int32 = 2, extra: [String: Any] = [:]) -> Never {
    var out: [String: Any] = ["ok": false, "error": message]
    out.merge(extra) { a, _ in a }
    emit(out)
    exit(code)
}

// MARK: - Arguments

struct Args {
    let command: String
    private var options: [String: String] = [:]
    private var flags: Set<String> = []

    init(_ argv: [String]) {
        guard let first = argv.first else { command = "help"; return }
        command = first
        var i = 1
        while i < argv.count {
            let a = argv[i]
            guard a.hasPrefix("--") else { fail("unexpected argument: \(a)") }
            let key = String(a.dropFirst(2))
            if Args.booleanFlags.contains(key) {
                flags.insert(key)
                i += 1
            } else {
                guard i + 1 < argv.count else { fail("--\(key) needs a value") }
                options[key] = argv[i + 1]
                i += 2
            }
        }
    }

    static let booleanFlags: Set<String> = ["no-click", "all", "help"]

    func string(_ key: String) -> String? { options[key] }
    func require(_ key: String) -> String {
        guard let v = options[key], !v.isEmpty else { fail("--\(key) is required for \(command)") }
        return v
    }
    func int(_ key: String, default d: Int) -> Int {
        guard let v = options[key] else { return d }
        guard let n = Int(v) else { fail("--\(key) must be an integer") }
        return n
    }
    func double(_ key: String, default d: Double) -> Double {
        guard let v = options[key] else { return d }
        guard let n = Double(v) else { fail("--\(key) must be a number") }
        return n
    }
    func flag(_ key: String) -> Bool { flags.contains(key) }
}

// MARK: - AX helpers

extension AXUIElement {
    func attr(_ name: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(self, name as CFString, &value) == .success else { return nil }
        return value
    }

    func string(_ name: String) -> String? {
        guard let v = attr(name) else { return nil }
        if let s = v as? String { return s.isEmpty ? nil : s }
        return nil
    }

    var role: String? { string(kAXRoleAttribute) }
    var subrole: String? { string(kAXSubroleAttribute) }
    var identifier: String? { string("AXIdentifier") }
    var title: String? { string(kAXTitleAttribute) }
    var label: String? { string(kAXDescriptionAttribute) }
    var help: String? { string(kAXHelpAttribute) }

    /// AXValue as JSON: strings, numbers and booleans pass through, anything else is described.
    var jsonValue: Any? {
        guard let v = attr(kAXValueAttribute) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n }
        if CFGetTypeID(v) == AXUIElementGetTypeID() { return nil }
        return String(describing: v)
    }

    var enabled: Bool? { (attr(kAXEnabledAttribute) as? NSNumber)?.boolValue }

    var children: [AXUIElement] {
        (attr(kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    var frame: CGRect? {
        guard let p = attr(kAXPositionAttribute), let s = attr(kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        // swiftlint:disable force_cast
        AXValueGetValue(p as! AXValue, .cgPoint, &point)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        // swiftlint:enable force_cast
        return CGRect(origin: point, size: size)
    }

    var actions: [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(self, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    func perform(_ action: String) -> AXError {
        AXUIElementPerformAction(self, action as CFString)
    }
}

func frameJSON(_ r: CGRect?) -> Any {
    guard let r else { return NSNull() }
    return ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height]
}

/// The attributes every command reports for an element.
func describe(_ e: AXUIElement) -> [String: Any] {
    var d: [String: Any] = [:]
    if let v = e.role { d["role"] = v }
    if let v = e.subrole { d["subrole"] = v }
    if let v = e.identifier { d["identifier"] = v }
    if let v = e.title { d["title"] = v }
    if let v = e.label { d["label"] = v }
    if let v = e.jsonValue { d["value"] = v }
    if let v = e.enabled { d["enabled"] = v }
    d["frame"] = frameJSON(e.frame)
    return d
}

/// The app element's children plus its extras menu bar (where the status item lives), which
/// some AppKit versions leave out of `AXChildren`.
func roots(of app: AXUIElement) -> [AXUIElement] {
    var out = app.children
    if let extras = app.attr("AXExtrasMenuBar"), CFGetTypeID(extras) == AXUIElementGetTypeID() {
        // swiftlint:disable:next force_cast
        let bar = extras as! AXUIElement
        if !out.contains(where: { CFEqual($0, bar) }) { out.append(bar) }
    }
    return out
}

func appElement(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3)
    return app
}

func requirePID(_ args: Args) -> pid_t {
    guard let raw = args.string("pid"), let pid = Int32(raw), pid > 0 else { fail("--pid <pid> is required") }
    guard NSRunningApplication(processIdentifier: pid) != nil || kill(pid, 0) == 0 else {
        fail("no process with pid \(pid)")
    }
    guard AXIsProcessTrusted() else {
        fail("this process is not trusted for Accessibility (System Settings → Privacy & Security → Accessibility, add the terminal running tray-driver)")
    }
    return pid
}

/// Breadth-first search for an element. BFS so the shallowest match wins: an `NSMenuItem`'s
/// identifier is reported on the AXMenuItem, and its custom view can repeat it one level down.
func findElement(in app: AXUIElement, maxDepth: Int = 40, where match: (AXUIElement) -> Bool) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = roots(of: app).map { ($0, 1) }
    var index = 0
    while index < queue.count {
        let (e, depth) = queue[index]
        index += 1
        if match(e) { return e }
        if depth < maxDepth { queue.append(contentsOf: e.children.map { ($0, depth + 1) }) }
    }
    return nil
}

func findByID(_ app: AXUIElement, _ id: String, timeout: Double) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let e = findElement(in: app, where: { $0.identifier == id }) { return e }
        if Date() >= deadline { break }
        usleep(200_000)
    } while true
    return nil
}

/// How long a lookup keeps retrying. Not zero by default: the app rebuilds its whole status
/// menu on every refresh (each poll and hub event), and a walk that lands mid-rebuild sees the
/// old items go invalid and misses an element that is there. Pass `--timeout 0` to assert that
/// something is ABSENT.
func lookupTimeout(_ args: Args) -> Double { args.double("timeout", default: 1.5) }

func statusItem(_ app: AXUIElement) -> AXUIElement? {
    if let e = findElement(in: app, maxDepth: 3, where: { $0.identifier == "agentbox.statusItem" }) { return e }
    // Older builds without identifiers: the one menu bar item of the extras bar.
    guard let extras = app.attr("AXExtrasMenuBar"), CFGetTypeID(extras) == AXUIElementGetTypeID() else { return nil }
    // swiftlint:disable:next force_cast
    return (extras as! AXUIElement).children.first
}

/// The status item's menu, open or not: AppKit lists an assigned menu (and every item in it,
/// identifiers included) while it is closed, with zero-size frames.
func statusMenu(_ app: AXUIElement) -> AXUIElement? {
    statusItem(app)?.children.first { $0.role == kAXMenuRole }
}

/// The status item's menu if it is on screen now.
func openMenu(_ app: AXUIElement) -> AXUIElement? {
    guard let menu = statusMenu(app), let f = menu.frame, f.width > 0, f.height > 0 else { return nil }
    return menu
}

// MARK: - Tree

func tree(_ e: AXUIElement, depth: Int, maxDepth: Int, maxChildren: Int) -> [String: Any] {
    var node = describe(e)
    guard depth < maxDepth else {
        let n = e.children.count
        if n > 0 { node["truncatedChildren"] = n }
        return node
    }
    let kids = e.children
    if !kids.isEmpty {
        node["children"] = kids.prefix(maxChildren).map { tree($0, depth: depth + 1, maxDepth: maxDepth, maxChildren: maxChildren) }
        if kids.count > maxChildren { node["truncatedChildren"] = kids.count - maxChildren }
    }
    return node
}

// MARK: - Input

/// A left click at a global (top-left origin) point. This is a real HID event: it moves the
/// pointer and lands on whatever is on screen there, so it is only the fallback for an element
/// that refuses AXPress, and never runs while the screen is locked.
func click(at point: CGPoint) -> Bool {
    guard !sessionInfo().locked else { return false }
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else { return false }
    down.post(tap: .cghidEventTap)
    usleep(60_000)
    up.post(tap: .cghidEventTap)
    return true
}

/// Escape delivered to one process only (`postToPid`), so it cannot reach the frontmost app.
func escape(to pid: pid_t) {
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        CGEvent(keyboardEventSource: source, virtualKey: 0x35, keyDown: down)?.postToPid(pid)
        usleep(30_000)
    }
}

/// AXPress, tolerating the one "error" a menu-opening press returns: the target app enters the
/// menu's modal tracking loop and does not answer until it closes, so the call times out
/// (`cannotComplete`) although the press landed.
func press(_ e: AXUIElement, timeout: Float = 1.0) -> AXError {
    AXUIElementSetMessagingTimeout(e, timeout)
    return e.perform(kAXPressAction)
}

// MARK: - Session / frontmost

struct Session {
    let locked: Bool
    let onConsole: Bool
}

func sessionInfo() -> Session {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return Session(locked: false, onConsole: true) }
    let locked = (dict["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    let onConsole = (dict[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue ?? true
    return Session(locked: locked, onConsole: onConsole)
}

// MARK: - Windows

func windows(of pid: pid_t) -> [[String: Any]] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
}

func bounds(_ w: [String: Any]) -> CGRect? {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b)
}

// MARK: - Commands

let usage = """
tray-driver <command> --pid <pid> [options]   (JSON on stdout)

  tree        [--depth N=14] [--max-children N=200] [--id <root identifier>]
  open-menu   [--timeout S=3]         press the status item, wait for its menu
  close-menu                          AXCancel the open menu, else Esc to that pid only
  find        --id <identifier> [--timeout S=1.5]    exit 1 if missing (--timeout 0 to assert absence)
  press       --id <identifier> [--timeout S=1.5] [--no-click]
  set-value   --id <identifier> --value <text>
  select      --id <popup identifier> --title <item title>
  screenshot  --out <file.png> [--id <identifier>] [--pad N=0]
  frontmost                           (no --pid) frontmost app, lock state, idle seconds
"""

let args = Args(Array(CommandLine.arguments.dropFirst()))

switch args.command {
case "help", "--help", "-h":
    print(usage)

case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    let session = sessionInfo()
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    emit([
        "ok": true,
        "bundleId": app?.bundleIdentifier ?? NSNull(),
        "name": app?.localizedName ?? NSNull(),
        "pid": app.map { Int($0.processIdentifier) } ?? NSNull(),
        "screenLocked": session.locked,
        "onConsole": session.onConsole,
        "idleSeconds": NSDecimalNumber(string: String(format: "%.1f", idle)),
        "axTrusted": AXIsProcessTrusted(),
    ])

case "tree":
    let pid = requirePID(args)
    let app = appElement(pid)
    let maxDepth = args.int("depth", default: 14)
    let maxChildren = args.int("max-children", default: 200)
    if let id = args.string("id") {
        guard let root = findByID(app, id, timeout: lookupTimeout(args)) else { fail("no element with identifier \(id)", code: 1) }
        emit(["ok": true, "pid": Int(pid), "tree": tree(root, depth: 0, maxDepth: maxDepth, maxChildren: maxChildren)])
    } else {
        var node = describe(app)
        node["children"] = roots(of: app).map { tree($0, depth: 1, maxDepth: maxDepth, maxChildren: maxChildren) }
        emit(["ok": true, "pid": Int(pid), "tree": node])
    }

case "open-menu":
    let pid = requirePID(args)
    let app = appElement(pid)
    if let menu = openMenu(app) {
        emit(["ok": true, "alreadyOpen": true, "menu": describe(menu)])
        break
    }
    guard let item = statusItem(app) else { fail("status item not found", code: 1) }
    let err = press(item)
    let deadline = Date().addingTimeInterval(args.double("timeout", default: 3))
    var menu: AXUIElement?
    while Date() < deadline {
        menu = openMenu(app)
        if menu != nil { break }
        usleep(150_000)
    }
    guard let menu else { fail("menu did not open (AXPress returned \(err.rawValue))", code: 1) }
    emit(["ok": true, "alreadyOpen": false, "menu": describe(menu), "items": menu.children.count])

case "close-menu":
    let pid = requirePID(args)
    let app = appElement(pid)
    guard let menu = openMenu(app) else {
        emit(["ok": true, "wasOpen": false])
        break
    }
    AXUIElementSetMessagingTimeout(menu, 1)
    var method = "AXCancel"
    if menu.perform(kAXCancelAction) != .success {
        method = "escape"
        escape(to: pid)
    }
    usleep(300_000)
    let stillOpen = openMenu(app) != nil
    if stillOpen { fail("menu is still open after \(method)", code: 1) }
    emit(["ok": true, "wasOpen": true, "method": method])

case "find":
    let pid = requirePID(args)
    let id = args.require("id")
    let app = appElement(pid)
    guard let e = findByID(app, id, timeout: lookupTimeout(args)) else {
        fail("no element with identifier \(id)", code: 1, extra: ["found": false, "id": id])
    }
    var out = describe(e)
    out["ok"] = true
    out["found"] = true
    out["actions"] = e.actions
    emit(out)

case "press":
    let pid = requirePID(args)
    let id = args.require("id")
    let app = appElement(pid)
    guard let e = findByID(app, id, timeout: lookupTimeout(args)) else {
        fail("no element with identifier \(id)", code: 1, extra: ["found": false, "id": id])
    }
    let err = press(e)
    // `cannotComplete` is a press that opened a modal loop (a menu, a submenu) — it landed.
    if err == .success || err == .cannotComplete {
        emit(["ok": true, "id": id, "method": "AXPress", "axResult": Int(err.rawValue)])
        break
    }
    guard !args.flag("no-click") else { fail("AXPress failed (\(err.rawValue)) and --no-click was given", code: 1) }
    guard let f = e.frame, f.width > 0, f.height > 0 else { fail("AXPress failed (\(err.rawValue)) and the element has no frame", code: 1) }
    let center = CGPoint(x: f.midX, y: f.midY)
    guard click(at: center) else { fail("AXPress failed (\(err.rawValue)) and a click is not allowed (screen locked?)", code: 1) }
    emit(["ok": true, "id": id, "method": "click", "axResult": Int(err.rawValue), "point": ["x": center.x, "y": center.y]])

case "set-value":
    let pid = requirePID(args)
    let id = args.require("id")
    let value = args.require("value")
    let app = appElement(pid)
    guard let e = findByID(app, id, timeout: lookupTimeout(args)) else {
        fail("no element with identifier \(id)", code: 1, extra: ["found": false, "id": id])
    }
    _ = AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let err = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, value as CFString)
    guard err == .success else { fail("setting AXValue failed (\(err.rawValue))", code: 1) }
    emit(["ok": true, "id": id, "value": e.jsonValue ?? NSNull()])

case "select":
    let pid = requirePID(args)
    let id = args.require("id")
    let title = args.require("title")
    let app = appElement(pid)
    guard let popup = findByID(app, id, timeout: lookupTimeout(args)) else {
        fail("no element with identifier \(id)", code: 1, extra: ["found": false, "id": id])
    }
    _ = press(popup)
    var item: AXUIElement?
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline, item == nil {
        item = findElement(in: popup, maxDepth: 4) { $0.role == kAXMenuItemRole && $0.title == title }
        if item == nil { usleep(150_000) }
    }
    guard let item else {
        if let menu = popup.children.first(where: { $0.role == kAXMenuRole }) { _ = menu.perform(kAXCancelAction) }
        fail("no item titled \(title) in \(id)", code: 1)
    }
    _ = press(item)
    usleep(200_000)
    emit(["ok": true, "id": id, "value": popup.jsonValue ?? NSNull()])

case "screenshot":
    let pid = requirePID(args)
    let out = args.require("out")
    let pad = CGFloat(args.int("pad", default: 0))
    var region: CGRect?
    var windowIDs: [Int] = []
    let mine = windows(of: pid)
    if let id = args.string("id") {
        let app = appElement(pid)
        guard let e = findByID(app, id, timeout: lookupTimeout(args)), let f = e.frame else {
            fail("no element with identifier \(id)", code: 1)
        }
        region = f.insetBy(dx: -pad, dy: -pad)
    } else {
        // The app's own on-screen windows, minus the status item's slot in the menu bar (layer
        // 25): an open menu, the New Box card, a detail window. One window is captured by id
        // (exact, shadow-free); several by their union, which is still only this app's region.
        let content = mine.filter { w in
            let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard let b = bounds(w) else { return false }
            return layer != Int(CGWindowLevelForKey(.statusWindow)) && b.width > 30 && b.height > 30
        }
        guard !content.isEmpty else { fail("pid \(pid) has no on-screen window (open the menu or a window first)", code: 1) }
        windowIDs = content.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
        if content.count > 1 {
            region = content.compactMap(bounds).reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -pad, dy: -pad)
        }
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    if let r = region {
        task.arguments = ["-x", "-R\(Int(r.origin.x)),\(Int(r.origin.y)),\(Int(r.width.rounded(.up))),\(Int(r.height.rounded(.up)))", out]
    } else {
        task.arguments = ["-x", "-o", "-l", String(windowIDs[0]), out]
    }
    do { try task.run() } catch { fail("screencapture: \(error)") }
    task.waitUntilExit()
    guard task.terminationStatus == 0, FileManager.default.fileExists(atPath: out) else {
        fail("screencapture exited \(task.terminationStatus) (Screen Recording permission?)", code: 1)
    }
    emit([
        "ok": true, "out": out,
        "mode": region == nil ? "window" : "region",
        "windowIds": windowIDs,
        "region": frameJSON(region),
    ])

default:
    fail("unknown command \(args.command)\n\(usage)")
}
