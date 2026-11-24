#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift NeonCorePush class to React Native's module registry. Swift alone
// can't declare the module/method table, so this bridging file does it.
@interface RCT_EXTERN_MODULE (NeonCorePush, RCTEventEmitter)

RCT_EXTERN_METHOD(register)
RCT_EXTERN_METHOD(getDeviceToken : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

// Over-the-air updates (NeonCoreUpdates in NeonCorePush.swift).
RCT_EXTERN_METHOD(otaConfigure : (NSString *)server token : (NSString *)token)
RCT_EXTERN_METHOD(otaMarkHealthy)
RCT_EXTERN_METHOD(otaCheckNow)
RCT_EXTERN_METHOD(otaApplyNow)
RCT_EXTERN_METHOD(otaStatus : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

@end
