# micro:bit Android BLE example

This is a minimal React Native example that connects to a micro:bit V1 over BLE and writes the LED matrix characteristic to turn LEDs on/off.

Key UUIDs (micro:bit V1):
- LED Service: `E95DD91D-251D-470A-A062-FA1922DFA9A8`
- LED Matrix Characteristic: `E95D7B77-251D-470A-A062-FA1922DFA9A8`

Setup (bare React Native project):

1. Create a React Native project or use this folder as your app root.
2. Install dependencies:

```bash
npm install
npm install react-native-ble-plx buffer
```

3. Android specific: ensure you have added Bluetooth permissions in `android/app/src/main/AndroidManifest.xml` and enabled location permissions at runtime for Android 6+.

4. Run Metro and install on a connected Android device/emulator:

```bash
npm run android
```

Notes:
- This example uses `react-native-ble-plx`. Follow its README for native setup steps and ProGuard/shadowing details.
- The app writes 5 bytes to the LED Matrix characteristic. Each byte represents a row (top->bottom) and bits 4..0 map to LEDs left->right.
