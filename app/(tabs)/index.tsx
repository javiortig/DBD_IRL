import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import React, { useEffect, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

const MAX_PLAYERS = 4;
const SOLO_SECONDS = 80;
const BOOST_PER_EXTRA = 1;
const EXTRA_PLAYERS_PENALTY = 0.8;

function getSpeedMultiplier(players: number) {
  return Math.pow(players, EXTRA_PLAYERS_PENALTY);
}


export default function Engine() {
  useKeepAwake();
  const [progress, setProgress] = useState(0);
  const [playersTouching, setPlayersTouching] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [paused, setPaused] = useState(false);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  const basePerSecond = 1 / SOLO_SECONDS;

  useEffect(() => {
    const loop = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      setProgress((prev) => {
        if (paused || isComplete) return prev;
        const mult = getSpeedMultiplier(playersTouching) * BOOST_PER_EXTRA;
        const rate = basePerSecond * mult;
        const next = Math.min(1, prev + rate * dt);
        if (next >= 1 && !isComplete) triggerComplete();
        return next;
      });

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playersTouching, paused, isComplete]);

  const triggerComplete = async () => {
    setIsComplete(true);
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {}
  };

  const reset = async () => {
    setProgress(0);
    setIsComplete(false);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const onTouchUpdate = (evt: any) => {
    const touches = evt?.nativeEvent?.touches?.length ?? 0;
    const clamped = Math.min(touches, MAX_PLAYERS);
    setPlayersTouching(clamped);
  };

  const onTouchEnd = (evt: any) => {
    const touches = evt?.nativeEvent?.touches?.length ?? 0;
    setPlayersTouching(Math.min(touches, MAX_PLAYERS));
  };

  const percent = Math.round(progress * 100);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar hidden />
      <View style={styles.container}>
        <View
          style={[styles.engineArea, isComplete && styles.engineComplete]}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onTouchUpdate}
          onResponderMove={onTouchUpdate}
          onResponderRelease={onTouchEnd}
          onResponderTerminate={onTouchEnd}
          accessible accessibilityLabel="Área del motor. Mantén dedos para reparar"
        >
          <Text style={styles.title}>MOTOR</Text>
          <Text style={styles.players}>
            Jugadores reparando: {playersTouching} / {MAX_PLAYERS}
          </Text>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
          <Text style={styles.percent}>{percent}%</Text>
          {isComplete ? (
            <Text style={styles.completeLabel}>¡REPARADO!</Text>
          ) : playersTouching > 0 ? (
            <Text style={styles.hint}>No levantéis los dedos…</Text>
          ) : (
            <Text style={styles.hint}>Colocad hasta 4 dedos a la vez</Text>
          )}
        </View>

        <View style={styles.controls}>
          <Pressable style={[styles.button, styles.primary]} onPress={reset}>
            <Text style={styles.buttonText}>Reiniciar</Text>
          </Pressable>

          <Pressable
            style={[styles.button, paused ? styles.primary : styles.secondary]}
            onPress={() => setPaused((p) => !p)}
          >
            <Text style={styles.buttonText}>{paused ? "Reanudar" : "Pausar"}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0e10" },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: "#0b0e10",
  },
  engineArea: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#333",
    backgroundColor: "#12161a",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  engineComplete: { borderColor: "#4ade80", backgroundColor: "#122417" },
  title: { color: "#e5e7eb", fontSize: 32, fontWeight: "800", letterSpacing: 2 },
  players: { color: "#9ca3af", marginTop: 6, fontSize: 16 },
  progressBar: {
    width: "90%",
    height: 22,
    borderRadius: 12,
    backgroundColor: "#1f2937",
    marginTop: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#374151",
  },
  progressFill: { height: "100%", backgroundColor: "#60a5fa" },
  percent: { color: "#e5e7eb", marginTop: 8, fontSize: 18, fontVariant: ["tabular-nums"] },
  completeLabel: { color: "#4ade80", marginTop: 10, fontSize: 22, fontWeight: "700" },
  hint: { color: "#94a3b8", marginTop: 10, fontSize: 14 },
  controls: { flexDirection: "row", gap: 12, justifyContent: "center", marginTop: 14 },
  button: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  primary: { backgroundColor: "#1f2937", borderColor: "#374151" },
  secondary: { backgroundColor: "#0f172a", borderColor: "#1f2937" },
  buttonText: { color: "#e5e7eb", fontSize: 16, fontWeight: "600" },
});