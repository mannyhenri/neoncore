import Foundation
import React

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
