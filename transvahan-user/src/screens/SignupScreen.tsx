import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import axios from "axios";
import Constants from "expo-constants";
import { useTheme } from "../context/ThemeContext";

const API = Constants.expoConfig?.extra?.API_BASE_URL;

export default function SignupScreen({ navigation }: any) {
  const { colors: C } = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const validateEmail = (val: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());

  const onSignup = async () => {
    console.log("Signup API base:", API);

    if (!name || !email || !password || !confirm) {
      Alert.alert("⚠️ Missing Fields", "Please fill all fields.");
      return;
    }
    if (!validateEmail(email)) {
      Alert.alert("⚠️ Invalid Email", "Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      Alert.alert("⚠️ Weak Password", "Password must be at least 6 characters long.");
      return;
    }
    if (password !== confirm) {
      Alert.alert("⚠️ Password mismatch", "Passwords do not match.");
      return;
    }

    try {
      setLoading(true);

      await axios.post(`${API}/auth/signup`, {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password, // plaintext
      });

      Alert.alert("📩 OTP Sent", "Please verify the OTP sent to your email.");
      navigation.replace("VerifyOtp", { email: email.trim().toLowerCase() });
    } catch (err: any) {
      console.error(
        "Signup error",
        err?.response?.status,
        err?.response?.data || err?.message
      );
      Alert.alert("Signup failed", err?.response?.data?.error ?? "Try again later.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: C.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.form}>
            <Text style={[styles.title, { color: C.text }]}>Create Account</Text>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: C.text }]}>Full Name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Enter your full name"
                placeholderTextColor={C.mutedText}
                style={[
                  styles.input,
                  {
                    backgroundColor: C.inputBg,
                    borderColor: C.inputBorder,
                    color: C.text,
                  },
                ]}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: C.text }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Enter your email"
                placeholderTextColor={C.mutedText}
                autoCapitalize="none"
                keyboardType="email-address"
                style={[
                  styles.input,
                  {
                    backgroundColor: C.inputBg,
                    borderColor: C.inputBorder,
                    color: C.text,
                  },
                ]}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: C.text }]}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                placeholderTextColor={C.mutedText}
                secureTextEntry={!showPassword}
                style={[
                  styles.input,
                  {
                    backgroundColor: C.inputBg,
                    borderColor: C.inputBorder,
                    color: C.text,
                  },
                ]}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: C.text }]}>Confirm Password</Text>
              <TextInput
                value={confirm}
                onChangeText={setConfirm}
                placeholder="Confirm your password"
                placeholderTextColor={C.mutedText}
                secureTextEntry={!showPassword}
                style={[
                  styles.input,
                  {
                    backgroundColor: C.inputBg,
                    borderColor: C.inputBorder,
                    color: C.text,
                  },
                ]}
              />
            </View>

            <Pressable onPress={() => setShowPassword((v) => !v)}>
              <Text style={[styles.link, { color: C.primary }]}>
                {showPassword ? "Hide Password" : "Show Password"}
              </Text>
            </Pressable>

            <Pressable
              onPress={onSignup}
              disabled={loading}
              style={[
                styles.btn,
                {
                  backgroundColor: C.primary,
                  opacity: loading ? 0.6 : 1,
                },
              ]}
            >
              <Text style={styles.btnText}>{loading ? "Signing Up…" : "Sign Up"}</Text>
            </Pressable>

            <Pressable onPress={() => navigation.replace("Login")} style={styles.backLink}>
              <Text style={[styles.backText, { color: C.mutedText }]}>
                Already have an account? <Text style={{ color: C.primary }}>Log In</Text>
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  form: {
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    marginBottom: 20,
    textAlign: "center",
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    padding: 14,
    borderRadius: 10,
    fontSize: 16,
  },
  link: {
    fontWeight: "600",
    fontSize: 14,
  },
  btn: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 16,
  },
  btnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  backLink: {
    alignItems: "center",
    marginTop: 16,
  },
  backText: {
    fontSize: 14,
  },
});
