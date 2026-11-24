import Foundation
import React
import CryptoKit

/**
 * Minimal native push bridge — Apple frameworks only, no third-party push SDK.
 *
 * JS calls `register()`, which asks for notification permission and registers with APNs.
 * The device token arrives asynchronously in AppDelegate's
 * didRegisterForRemoteNotificationsWithDeviceToken, so it's delivered to JS as an event
 * (and cached, so JS that starts listening late can still fetch it via getDeviceToken()).
 *
 * Events emitted:
 *   NeonCorePushToken       { token }                     APNs device token (hex)
 *   NeonCorePushError       { error }                     permission denied / APNs failure
 *   NeonCorePushOpened      { ...userInfo }               user tapped a notification
 */
@objc(NeonCorePush)
class NeonCorePush: RCTEventEmitter {
  @objc static let shared = NeonCorePush()

  private var deviceToken: String?
  private var launchNotification: [AnyHashable: Any]?
  private var listening = false

  // RCTEventEmitter instantiates its own instance; `shared` is what AppDelegate talks to.
  // Bridging the two through a static keeps the delivery path simple.
  private static weak var active: NeonCorePush?

  override init() {
    super.init()
    NeonCorePush.active = self
  }

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String] {
    ["NeonCorePushToken", "NeonCorePushError", "NeonCorePushOpened"]
  }

  override func startObserving() {
    listening = true
    // Flush anything that happened before JS subscribed.
    if let token = NeonCorePush.shared.deviceToken {
      sendEvent(withName: "NeonCorePushToken", body: ["token": token])
    }
    if let launch = NeonCorePush.shared.launchNotification {
      NeonCorePush.shared.launchNotification = nil
      sendEvent(withName: "NeonCorePushOpened", body: launch)
    }
  }

  override func stopObserving() {
    listening = false
  }

  // MARK: - Called from JS

  /// Ask for permission and register with APNs.
  @objc func register() {
    AppDelegate.requestPushAuthorization()
  }

  /// Resolve the cached APNs token (null until registration completes).
  @objc(getDeviceToken:rejecter:)
  func getDeviceToken(_ resolve: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) {
    resolve(NeonCorePush.shared.deviceToken)
  }

  // MARK: - Over-the-air updates (NeonCoreUpdates, below), called from JS (src/ota.ts)

  /// Where updates come from: the NeonCore server this phone uses, and its token.
  @objc(otaConfigure:token:)
  func otaConfigure(_ server: String, token: String) {
    NeonCoreUpdates.configure(server: server, token: token)
  }

  /// The running version started cleanly. One that never says so is rolled back.
  @objc func otaMarkHealthy() {
    NeonCoreUpdates.markHealthy()
  }

  /// Look for a newer version now (the app came to the front).
  @objc func otaCheckNow() {
    NeonCoreUpdates.checkInBackground()
  }

  /// Switch to the downloaded version now: React Native reloads, and the reload asks AppDelegate
  /// for its bundle again, where launchBundle() promotes `ota.next`. Nothing waiting: nothing happens.
  @objc func otaApplyNow() {
    guard let next = NeonCoreUpdates.status()["next"] as? String, !next.isEmpty else { return }
    DispatchQueue.main.async { RCTTriggerReloadCommandListeners("Over-the-air update") }
  }

  /// What is running, what is waiting for the next launch, and the last check.
  @objc(otaStatus:rejecter:)
  func otaStatus(_ resolve: RCTPromiseResolveBlock, rejecter _: RCTPromiseRejectBlock) {
    resolve(NeonCoreUpdates.status())
  }

  // MARK: - Called from AppDelegate

  func setDeviceToken(_ token: String) {
    deviceToken = token
    NeonCorePush.active?.emit("NeonCorePushToken", ["token": token])
  }

  func setLaunchNotification(_ userInfo: [AnyHashable: Any]) {
    launchNotification = userInfo
  }

  func emitRegistrationFailed(_ message: String) {
    NeonCorePush.active?.emit("NeonCorePushError", ["error": message])
  }

  func emitNotificationOpened(_ userInfo: [AnyHashable: Any]) {
    guard let active = NeonCorePush.active, active.listening else {
      // JS isn't listening yet (cold start) — hold it for startObserving to flush.
      launchNotification = userInfo
      return
    }
    active.emit("NeonCorePushOpened", userInfo)
  }

  private func emit(_ name: String, _ body: Any) {
    guard listening else { return }
    sendEvent(withName: name, body: body)
  }
}

/**
 * OVER-THE-AIR UPDATES from the NeonCore server (server/src/lib/mobile-updates.ts).
 *
 * The app's JavaScript can be replaced without a new build. On launch, AppDelegate asks
 * `launchBundle()` which bundle to run: a downloaded version made for THIS native build's
 * `runtime`, or nil for the one inside the app. After launch, `checkInBackground()` asks the
 * server for a newer version, downloads every file into Application Support, checks each file's
 * sha256, and leaves it for the NEXT launch — the running app never changes under the person.
 *
 * Safety: a new version starts on probation. JS calls `markHealthy()` once it has run for a few
 * seconds; a version that has not done so after three launches is rolled back to the one before
 * it and is never offered again. Nothing here can make the app unable to start: with no usable
 * download it runs the bundle it was built with.
 *
 * Apple frameworks only (Foundation, CryptoKit). State lives in UserDefaults (keys "ota.*").
 */
final class NeonCoreUpdates {
  /// The native build's compatibility number. A bundle runs only on the runtime it was built for.
  /// Bump it — here AND in mobile/src/ota.ts (OTA_RUNTIME) — whenever native code or a native
  /// dependency changes; mobile/src/__tests__/ota.test.ts checks the two agree.
  static let runtime = "1"
  /// Launches a new version may take without reporting healthy before it is rolled back.
  static let probationLaunches = 3

  private static let defaults = UserDefaults.standard
  private static let queue = DispatchQueue(label: "dev.neoncore.ota")
  private static var checking = false
  private static var resolved = false
  private static var launchedURL: URL?
  private static var runningVersion = ""

  private static var root: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("NeonCoreUpdates", isDirectory: true)
  }

  private static func folder(_ version: String) -> URL {
    root.appendingPathComponent(version, isDirectory: true)
  }

  private static func manifest(_ version: String) -> [String: Any]? {
    let file = folder(version).appendingPathComponent("manifest.json")
    guard let data = try? Data(contentsOf: file),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json
  }

  private static var bad: [String] { defaults.stringArray(forKey: "ota.bad") ?? [] }

  /// Downloaded, complete, for this runtime, and never rolled back.
  private static func usable(_ version: String?) -> Bool {
    guard let version = version, !version.isEmpty, !bad.contains(version),
          let m = manifest(version), (m["runtime"] as? String) == runtime else { return false }
    return FileManager.default.fileExists(atPath: folder(version).appendingPathComponent("main.jsbundle").path)
  }

  // MARK: Launch

  /// The bundle to launch: a downloaded version for this runtime, or nil for the one in the app.
  /// Decided once per process (React asks more than once).
  static func launchBundle() -> URL? {
    if resolved { return launchedURL }
    resolved = true

    // A new build from Xcode / TestFlight brings its own, newer code: what was downloaded for the
    // build before it is let go, and this build starts from the code inside it.
    let build = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? ""
    if defaults.string(forKey: "ota.build") != build {
      for key in ["ota.current", "ota.previous", "ota.next", "ota.probation", "ota.probationLaunches", "ota.lastError"] {
        defaults.removeObject(forKey: key)
      }
      defaults.set(build, forKey: "ota.build")
      try? FileManager.default.removeItem(at: root)
    }

    // A version downloaded last time takes over from this launch, on probation.
    if let next = defaults.string(forKey: "ota.next") {
      defaults.removeObject(forKey: "ota.next")
      if usable(next) {
        if let current = defaults.string(forKey: "ota.current") {
          defaults.set(current, forKey: "ota.previous")
        } else {
          defaults.removeObject(forKey: "ota.previous")
        }
        defaults.set(next, forKey: "ota.current")
        defaults.set(next, forKey: "ota.probation")
        defaults.set(0, forKey: "ota.probationLaunches")
      }
    }

    // On probation for too many launches without a healthy report: back to the one before it.
    if let probation = defaults.string(forKey: "ota.probation") {
      let launches = defaults.integer(forKey: "ota.probationLaunches") + 1
      defaults.set(launches, forKey: "ota.probationLaunches")
      if launches > probationLaunches {
        defaults.set(bad + [probation], forKey: "ota.bad")
        defaults.removeObject(forKey: "ota.probation")
        defaults.removeObject(forKey: "ota.probationLaunches")
        let previous = defaults.string(forKey: "ota.previous")
        if usable(previous) {
          defaults.set(previous, forKey: "ota.current")
        } else {
          defaults.removeObject(forKey: "ota.current")
        }
        defaults.removeObject(forKey: "ota.previous")
        defaults.set("Version \(probation) did not start properly, so the app went back to the one before it.", forKey: "ota.lastError")
      }
    }

    if let current = defaults.string(forKey: "ota.current") {
      if usable(current) {
        runningVersion = current
        launchedURL = folder(current).appendingPathComponent("main.jsbundle")
      } else {
        defaults.removeObject(forKey: "ota.current")
      }
    }
    return launchedURL
  }

  static func configure(server: String, token: String) {
    defaults.set(server, forKey: "ota.server")
    defaults.set(token, forKey: "ota.token")
  }

  static func markHealthy() {
    queue.async {
      if let probation = defaults.string(forKey: "ota.probation"), probation == runningVersion {
        defaults.removeObject(forKey: "ota.probation")
        defaults.removeObject(forKey: "ota.probationLaunches")
      }
    }
  }

  static func status() -> [String: Any] {
    return [
      "runtime": runtime,
      "running": runningVersion,
      "next": defaults.string(forKey: "ota.next") ?? "",
      "lastCheck": defaults.string(forKey: "ota.lastCheck") ?? "",
      "lastError": defaults.string(forKey: "ota.lastError") ?? "",
      "build": (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "",
    ]
  }

  // MARK: Checking and downloading

  private final class Response: @unchecked Sendable {
    var data: Data?
    var error: String?
  }

  /// One GET, waited for on the updates queue (never the main thread).
  private static func get(_ url: URL, token: String, timeout: TimeInterval = 60) -> Response {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let out = Response()
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        out.error = error.localizedDescription
      } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
        out.error = "the server answered \(http.statusCode)"
      } else {
        out.data = data
      }
      done.signal()
    }.resume()
    if done.wait(timeout: .now() + timeout + 5) == .timedOut { out.error = "timed out" }
    return out
  }

  /// When this build was made: its executable's date (ISO 8601, UTC).
  private static func builtAt() -> String? {
    guard let exe = Bundle.main.executableURL,
          let date = (try? FileManager.default.attributesOfItem(atPath: exe.path))?[.modificationDate] as? Date else { return nil }
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: date)
  }

  private static func hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  /// Ask the server for a newer version and download it for the next launch.
  static func checkInBackground() {
    queue.async {
      guard !checking, let server = defaults.string(forKey: "ota.server"), !server.isEmpty else { return }
      checking = true
      defer { checking = false }
      let token = defaults.string(forKey: "ota.token") ?? ""
      let have = defaults.string(forKey: "ota.next") ?? runningVersion
      defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: "ota.lastCheck")

      var components = URLComponents(string: server + "/api/mobile/update")
      var query = [URLQueryItem(name: "runtime", value: runtime), URLQueryItem(name: "current", value: have)]
      // Running the code built into the app: only what was published after this build is newer.
      if have.isEmpty, let built = builtAt() { query.append(URLQueryItem(name: "since", value: built)) }
      components?.queryItems = query
      guard let url = components?.url else { return }
      let answer = get(url, token: token, timeout: 20)
      guard let data = answer.data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        if let error = answer.error { defaults.set("Could not check for updates: \(error)", forKey: "ota.lastError") }
        return
      }
      guard let update = json["update"] as? [String: Any],
            let version = update["version"] as? String,
            (update["runtime"] as? String) == runtime,
            let files = update["files"] as? [[String: Any]],
            !bad.contains(version), version != runningVersion else { return }

      let fm = FileManager.default
      let staging = root.appendingPathComponent(".\(version).partial", isDirectory: true)
      try? fm.removeItem(at: staging)
      do { try fm.createDirectory(at: staging, withIntermediateDirectories: true) } catch { return }

      for file in files {
        guard let path = file["path"] as? String, let expected = file["sha256"] as? String,
              !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else {
          defaults.set("Update \(version) lists a file that cannot be stored.", forKey: "ota.lastError")
          try? fm.removeItem(at: staging)
          return
        }
        // Already on the phone (the running version, or the app as installed) and the same bytes: copy it.
        var body: Data? = nil
        var nearby = [Bundle.main.bundleURL.appendingPathComponent(path)]
        if !runningVersion.isEmpty { nearby.insert(folder(runningVersion).appendingPathComponent(path), at: 0) }
        for near in nearby {
          if let local = try? Data(contentsOf: near), hex(local) == expected { body = local; break }
        }
        let encoded = path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
        let versionPart = version.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? version
        guard let fileURL = URL(string: "\(server)/api/mobile/update/\(versionPart)/files/\(encoded)") else { return }
        if body == nil {
          let got = get(fileURL, token: token)
          if let fetched = got.data, hex(fetched) == expected { body = fetched } else {
            defaults.set("Update \(version) did not download cleanly (\(path): \(got.error ?? "its checksum does not match")).", forKey: "ota.lastError")
            try? fm.removeItem(at: staging)
            return
          }
        }
        guard let bytes = body else {
          try? fm.removeItem(at: staging)
          return
        }
        let target = staging.appendingPathComponent(path)
        do {
          try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
          try bytes.write(to: target, options: .atomic)
        } catch {
          try? fm.removeItem(at: staging)
          return
        }
      }
      guard let manifestData = try? JSONSerialization.data(withJSONObject: update),
            (try? manifestData.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)) != nil else {
        try? fm.removeItem(at: staging)
        return
      }
      let destination = folder(version)
      try? fm.removeItem(at: destination)
      do { try fm.moveItem(at: staging, to: destination) } catch { try? fm.removeItem(at: staging); return }
      defaults.set(version, forKey: "ota.next")
      defaults.removeObject(forKey: "ota.lastError")

      // Keep what is running, the one before it, and the one waiting — nothing else.
      let keep = Set([runningVersion, defaults.string(forKey: "ota.previous") ?? "", version])
      for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where !keep.contains(name) && !name.hasPrefix(".") {
        try? fm.removeItem(at: root.appendingPathComponent(name))
      }
    }
  }
}
