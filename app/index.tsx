// app/index.tsx
// Audio por tramos + variantes Repairing (sin Gen_start).
// - Histeresis "repairingSmooth" para ignorar taps rápidos.
// - Retención mínima de pista para evitar cambios nerviosos.
// - Al completar: loop de Generator_Completed + notificación one-shot.
// - Reset: silencio total.

import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import React, { useEffect, useRef, useState } from "react";
import {
	GestureResponderEvent,
	Pressable,
	SafeAreaView,
	StatusBar,
	StyleSheet,
	Text,
	View,
} from "react-native";

// ==== Parámetros del juego ====
const MAX_PLAYERS = 4;
const SOLO_SECONDS = 80;
const BOOST_PER_EXTRA = 1;
const MAX_PLAYER_REPAIR_PENALTY = 0.7;

// ==== Audio ====
const VOL = 0.7;
const XFADE_MS = 160; // duración del crossfade

const SFX = {
	gen1: require("../assets/sfx/Gen1.wav"),
	gen1Repair: require("../assets/sfx/Gen1_Repairing.wav"),
	gen2: require("../assets/sfx/Gen2.wav"),
	gen2Repair: require("../assets/sfx/Gen2_Repairing.wav"),
	gen3: require("../assets/sfx/Gen3.wav"),
	gen3Repair: require("../assets/sfx/Gen3_Repairing.wav"),
	gen4: require("../assets/sfx/Gen4.wav"),
	gen4Repair: require("../assets/sfx/Gen4_Repairing.wav"),
	completed: require("../assets/sfx/Generator_Completed.wav"),
	completedNotif: require("../assets/sfx/Generator_Completed_Notification.wav"),
} as const;

type TrackKey = keyof typeof SFX;

function getSpeedMultiplier(players: number) {
	return Math.pow(players, MAX_PLAYER_REPAIR_PENALTY);
}

// Fade simple
async function fadeVolume(sound: Audio.Sound, from: number, to: number, ms: number) {
	const steps = 6;
	const stepTime = Math.max(10, Math.round(ms / steps));
	for (let i = 0; i <= steps; i++) {
		const v = from + (to - from) * (i / steps);
		await sound.setVolumeAsync(v).catch(() => {});
		if (i < steps) await new Promise(r => setTimeout(r, stepTime));
	}
}

export default function Engine() {
	useKeepAwake();

	const [progress, setProgress] = useState(0); // 0..1
	const [playersTouching, setPlayersTouching] = useState(0);
	const [isComplete, setIsComplete] = useState(false);
	const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);

	const rafRef = useRef<number | null>(null);
	const lastTsRef = useRef<number | null>(null);
	const basePerSecond = 1 / SOLO_SECONDS;

	// AUDIO: precarga y estado
	const soundsRef = useRef<Partial<Record<TrackKey, Audio.Sound>>>({});
	const currentKeyRef = useRef<TrackKey | null>(null);
	const currentRef = useRef<Audio.Sound | null>(null);
	const stoppingRef = useRef(false);

	// ==== Histeresis para "repairing" ====
	const REPAIRING_ON_DELAY_MS = 120;
	const REPAIRING_OFF_DELAY_MS = 220;
	const [repairingSmooth, setRepairingSmooth] = useState(false);
	const onTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const offTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Retención mínima de pista para evitar cambios muy seguidos
	const MIN_TRACK_HOLD_MS = 250;
	const lastSwitchRef = useRef(0);

	useEffect(() => {
		Audio.setAudioModeAsync({
			playsInSilentModeIOS: true,
			staysActiveInBackground: false,
			shouldDuckAndroid: true,
			allowsRecordingIOS: false,
		}).catch(() => {});
	}, []);

	// Precarga
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				for (const key of Object.keys(SFX) as TrackKey[]) {
					if (!mounted) break;
					if (soundsRef.current[key]) continue;
					const { sound } = await Audio.Sound.createAsync(SFX[key], { shouldPlay: false, volume: VOL });
					if (!mounted) { await sound.unloadAsync(); break; }
					soundsRef.current[key] = sound;
				}
			} catch {}
		})();
		return () => { mounted = false; };
	}, []);

	// Bucle de progreso
	useEffect(() => {
		const loop = (ts: number) => {
			if (!lastTsRef.current) lastTsRef.current = ts;
			const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
			lastTsRef.current = ts;

			setProgress(prev => {
				if (isComplete) return prev;
				const mult = getSpeedMultiplier(playersTouching) * BOOST_PER_EXTRA;
				const rate = basePerSecond * mult;
				const next = Math.min(1, prev + rate * dt);
				if (next >= 1 && !isComplete) triggerComplete();
				return next;
			});

			rafRef.current = requestAnimationFrame(loop);
		};
		rafRef.current = requestAnimationFrame(loop);
		return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
	}, [playersTouching, isComplete]);

	const triggerComplete = async () => {
		setIsComplete(true);
		try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
		await crossfadeTo("completed");
		await playCompletedNotificationOnce();
	};

	// Histeresis repairingSmooth (suaviza taps rápidos)
	useEffect(() => {
		const raw = playersTouching > 0;

		// Limpiar timers previos
		if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
		if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }

		if (raw) {
			// Entrar a repairing tras pequeña espera
			if (!repairingSmooth) {
				onTimerRef.current = setTimeout(() => {
					setRepairingSmooth(true);
					onTimerRef.current = null;
				}, REPAIRING_ON_DELAY_MS);
			}
		} else {
			// Salir de repairing tras espera un poco mayor
			if (repairingSmooth) {
				offTimerRef.current = setTimeout(() => {
					setRepairingSmooth(false);
					offTimerRef.current = null;
				}, REPAIRING_OFF_DELAY_MS);
			}
		}

		return () => {
			if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
			if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }
		};
	}, [playersTouching, repairingSmooth]);

	// Notificación de completado una sola vez
	const playCompletedNotificationOnce = async () => {
		const s = soundsRef.current.completedNotif;
		if (!s) return;
		try {
			await s.setIsLoopingAsync(false);
			await s.setVolumeAsync(VOL);
			await s.setPositionAsync(0);
			await s.playAsync();
		} catch {}
	};

	// Pista a sonar por rango (p=0 → null ⇒ silencio)
	const chooseLoopTrack = (p: number, repairing: boolean): TrackKey | null => {
		if (p <= 0) return null; // silencio a 0%
		if (p > 0 && p <= 0.25) return repairing ? "gen1Repair" : "gen1";
		if (p > 0.25 && p <= 0.5) return repairing ? "gen2Repair" : "gen2";
		if (p > 0.5 && p <= 0.75) return repairing ? "gen3Repair" : "gen3";
		if (p > 0.75 && p < 1) return repairing ? "gen4Repair" : "gen4";
		return null;
	};

	// Observa cambios que afecten a audio
	useEffect(() => {
		(async () => {
			// Si está completo, asegúrate de estar en completed
			if (isComplete) {
				if (currentKeyRef.current !== "completed") {
					await crossfadeTo("completed");
				}
				return;
			}

			const desired = chooseLoopTrack(progress, repairingSmooth);

			// p=0 ⇒ silencio
			if (!desired) {
				if (currentRef.current) await crossfadeTo(null);
				return;
			}

			if (desired !== currentKeyRef.current) {
				await crossfadeTo(desired);
			}
		})().catch(() => {});
		 
	}, [progress, repairingSmooth, isComplete]);

	// Crossfade a nueva pista (o a silencio si key=null) con retención mínima
	const crossfadeTo = async (key: TrackKey | null) => {
		try {
			// Retén cambios demasiado seguidos (suaviza flapping)
			const now = Date.now();
			if (currentKeyRef.current !== key && now - lastSwitchRef.current < MIN_TRACK_HOLD_MS) {
				return;
			}
			lastSwitchRef.current = now;

			if (stoppingRef.current) return;
			stoppingRef.current = true;

			const current = currentRef.current;
			let next: Audio.Sound | null = null;

			if (key) {
				next = soundsRef.current[key] ?? null;
				if (next) {
					const shouldLoop = key !== "completedNotif"; // notif nunca por aquí
					await next.setIsLoopingAsync(shouldLoop);
					await next.setVolumeAsync(0);
					await next.setPositionAsync(0);
					await next.playAsync();
				}
			}

			if (current && next) {
				await Promise.all([
					fadeVolume(next, 0, VOL, XFADE_MS),
					fadeVolume(current, VOL, 0, XFADE_MS),
				]);
				await current.stopAsync().catch(() => {});
			} else if (!next && current) {
				await fadeVolume(current, VOL, 0, XFADE_MS);
				await current.stopAsync().catch(() => {});
			} else if (next && !current) {
				await fadeVolume(next, 0, VOL, XFADE_MS);
			}

			currentRef.current = key ? next : null;
			currentKeyRef.current = key ?? null;
		} finally {
			stoppingRef.current = false;
		}
	};

	// Reset: silencio total (y limpiar histeresis)
	const reset = async () => {
		setProgress(0);
		setIsComplete(false);
		setRepairingSmooth(false);
		try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}

		// Cancela timers de histeresis
		if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
		if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }

		// Silencio total
		if (currentRef.current) await crossfadeTo(null);

		// Por si la notificación estuviera sonando (poco probable)
		if (soundsRef.current.completedNotif) {
			await soundsRef.current.completedNotif.stopAsync().catch(() => {});
		}
	};

	// Limpieza total al desmontar
	useEffect(() => {
		return () => {
			(async () => {
				try {
					if (onTimerRef.current) { clearTimeout(onTimerRef.current); }
					if (offTimerRef.current) { clearTimeout(offTimerRef.current); }
					if (currentRef.current) {
						await currentRef.current.stopAsync().catch(() => {});
					}
					for (const k of Object.keys(soundsRef.current) as TrackKey[]) {
						await soundsRef.current[k]?.unloadAsync().catch(() => {});
					}
				} catch {}
			})();
		};
	}, []);

	// === Multitouch ===
	const updateTouches = (evt: GestureResponderEvent) => {
		const touches = (evt?.nativeEvent as any)?.touches ?? [];
		const sliced = touches.slice(0, MAX_PLAYERS);
		const points = sliced.map((t: any, idx: number) => ({
			id: t.identifier ?? idx,
			x: t.locationX,
			y: t.locationY,
		}));
		setTouchPoints(points);
		setPlayersTouching(points.length);
	};

	const handleGrant = (e: GestureResponderEvent) => updateTouches(e);
	const handleMove = (e: GestureResponderEvent) => updateTouches(e);
	const handleRelease = (e: GestureResponderEvent) => updateTouches(e);
	const handleTerminate = (e: GestureResponderEvent) => updateTouches(e);

	const percent = Math.round(progress * 100);

	return (
		<SafeAreaView style={styles.safe}>
			<StatusBar hidden />
			<View style={styles.container}>
				<View
					style={[styles.engineArea, isComplete && styles.engineComplete]}
					onStartShouldSetResponder={() => true}
					onMoveShouldSetResponder={() => true}
					onResponderGrant={handleGrant}
					onResponderMove={handleMove}
					onResponderRelease={handleRelease}
					onResponderTerminate={handleTerminate}
					accessible
					accessibilityLabel="Área del motor"
				>
					{touchPoints.map(p => (
						<View key={p.id} pointerEvents="none" style={[styles.touchRing, { left: p.x - 40, top: p.y - 40 }]} />
					))}
					<Text style={styles.title}>MOTOR</Text>
					<Text style={styles.players}>Jugadores reparando: {playersTouching} / {MAX_PLAYERS}</Text>
					<View style={styles.progressBar}>
						<View style={[styles.progressFill, { width: `${percent}%` }]} />
					</View>
					<Text style={styles.percent}>{percent}%</Text>
					{isComplete ? (
						<Text style={styles.completeLabel}>¡REPARADO!</Text>
					) : (
						<Text style={styles.hint}>Colocad hasta 4 dedos a la vez</Text>
					)}
				</View>

				<View style={styles.controls}>
					<Pressable style={[styles.button, styles.primary]} onPress={reset}>
						<Text style={styles.buttonText}>Reiniciar</Text>
					</Pressable>
				</View>
			</View>
		</SafeAreaView>
	);
}

// ==== Estilos ====
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
		position: "relative",
	},
	engineComplete: { borderColor: "#4ade80", backgroundColor: "#122417" },
	touchRing: {
		position: "absolute",
		width: 80,
		height: 80,
		borderRadius: 40,
		borderWidth: 2,
		borderColor: "#60a5fa",
		backgroundColor: "rgba(96,165,250,0.15)",
		shadowColor: "#60a5fa",
		shadowOpacity: 0.6,
		shadowRadius: 10,
		shadowOffset: { width: 0, height: 0 },
		elevation: 6,
	},
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
	buttonText: { color: "#e5e7eb", fontSize: 16, fontWeight: "600" },
});
