import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "NeonCore",
      in: window,
      launchOptions: launchOptions
    )

    // Deliver notifications while the app is foregrounded, and route taps. Without a
    // delegate, a notification arriving with the app open is silently swallowed.
    UNUserNotificationCenter.current().delegate = self

    // Cold start from a notification tap: stash the payload so JS can consume it once the
    // bridge is up (it isn't listening yet at this point in launch).
    if let remote = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
      NeonCorePush.shared.setLaunchNotification(remote)
    }

    return true
  }

  // MARK: - APNs registration

  /// Called by NeonCorePush.register() from JS. Asks for permission, then registers with
  /// Apple. Pure UserNotifications + UIApplication — no third-party push SDK.
  static func requestPushAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else {
        NeonCorePush.shared.emitRegistrationFailed("permission-denied")
        return
      }
      DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    // APNs wants the token as lowercase hex — that's exactly what the server sends back to
    // Apple in the /3/device/<token> path.
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    NeonCorePush.shared.setDeviceToken(token)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NeonCorePush.shared.emitRegistrationFailed(error.localizedDescription)
  }

  // MARK: - Foreground presentation + tap routing

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    NeonCorePush.shared.emitNotificationOpened(response.notification.request.content.userInfo)
    completionHandler()
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
