import React, { useRef } from 'react';
import { View, Text, StyleSheet, Animated, PanResponder } from 'react-native';
import { theme } from '../theme';

/**
 * Swipe a row to reveal a single action, then swipe past the threshold (or tap the revealed
 * action) to fire it.
 *
 * Built on RN core's PanResponder + Animated rather than react-native-gesture-handler's
 * Swipeable, on purpose: gesture-handler ships NATIVE code, which would force a new binary
 * and an App Store round trip. This stays pure JS, so it ships over the air in ~30s.
 *
 * Horizontal-only: the responder refuses to claim a gesture until horizontal travel clearly
 * beats vertical, so the list still scrolls normally under your thumb.
 */

const REVEAL = 96;      // how far the row rests when opened
const TRIGGER = 140;    // swipe past this and it fires without a second tap
const CLAIM_DX = 12;    // min horizontal travel before we take the gesture from the list

export function SwipeToDismiss({
  children,
  onAction,
  label = 'Hide',
  direction = 'right',
  disabled = false,
}: {
  children: React.ReactNode;
  onAction: () => void;
  label?: string;
  /** 'right' = swipe rightward, action panel sits on the left. */
  direction?: 'right' | 'left';
  disabled?: boolean;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const sign = direction === 'right' ? 1 : -1;

  const settle = (to: number) => {
    open.current = to !== 0;
    Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  };

  const fire = () => {
    // Slide the row fully out, then act — so the card visibly leaves rather than blinking away.
    Animated.timing(x, {
      toValue: sign * 400,
      duration: 160,
      useNativeDriver: true,
    }).start(() => {
      onAction();
      x.setValue(0);
      open.current = false;
    });
  };

  // Is this gesture ours? Clearly horizontal, in our direction, past a small deadzone.
  // Anything vertical is left alone so the FlatList scrolls normally.
  const isOurs = (g: { dx: number; dy: number }) =>
    !disabled &&
    Math.abs(g.dx) > CLAIM_DX &&
    Math.abs(g.dx) > Math.abs(g.dy) * 1.5 &&
    g.dx * sign > 0;

  const pan = useRef(
    PanResponder.create({
      // Never claim on touch-START — that would eat taps meant for the card.
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,

      // CAPTURE phase is essential here. The child card is a TouchableOpacity, which takes
      // the responder the moment you touch down. Once a child owns the touch, the bubbling
      // `onMoveShouldSetPanResponder` below is never consulted — so the swipe silently did
      // nothing. Capture runs top-down and lets us take the gesture back off the Touchable
      // as soon as the movement is clearly horizontal.
      onMoveShouldSetPanResponderCapture: (_e, g) => isOurs(g),
      onMoveShouldSetPanResponder: (_e, g) => isOurs(g),

      // Don't let the enclosing FlatList yank the gesture back mid-swipe.
      onPanResponderTerminationRequest: () => false,

      onPanResponderMove: (_e, g) => {
        const dx = g.dx * sign;
        if (dx < 0) return;                    // don't drag the wrong way
        x.setValue(sign * Math.min(dx, TRIGGER + 60));
      },
      onPanResponderRelease: (_e, g) => {
        const dx = g.dx * sign;
        if (dx > TRIGGER) fire();
        else if (dx > REVEAL / 2) settle(sign * REVEAL);
        else settle(0);
      },
      onPanResponderTerminate: () => settle(0),
    }),
  ).current;

  return (
    <View style={styles.wrap}>
      {/* Action panel, revealed behind the row */}
      <View style={[styles.action, direction === 'right' ? styles.actionLeft : styles.actionRight]}>
        <Text style={styles.actionText} onPress={fire}>
          {label}
        </Text>
      </View>

      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  action: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: REVEAL + 40,
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginVertical: 6,
    marginHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  actionLeft: { left: 0, alignItems: 'flex-start' },
  actionRight: { right: 0, alignItems: 'flex-end' },
  actionText: { color: theme.accentSoft, fontSize: 13, fontWeight: '700' },
});
