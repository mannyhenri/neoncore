#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift NeonCorePush class to React Native's module registry. Swift alone
// can't declare the module/method table, so this bridging file does it.
@interface RCT_EXTERN_MODULE (NeonCorePush, RCTEventEmitter)

RCT_EXTERN_METHOD(register)
RCT_EXTERN_METHOD(getDeviceToken : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

@end
