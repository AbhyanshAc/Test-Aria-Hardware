# micro:bit Android BLE example

This is a minimal Expo + React Native example that connects to a micro:bit V1 over BLE and writes the LED matrix characteristic to turn LEDs on/off.

Key UUIDs (micro:bit V1):
- LED Service: `E95DD91D-251D-470A-A062-FA1922DFA9A8`
- LED Matrix Characteristic: `E95D7B77-251D-470A-A062-FA1922DFA9A8`

Windows setup notes
1. Install Java 17 JDK and make sure Gradle uses it.
2. In PowerShell, point the environment to Java 17:

```powershell
$env:JAVA_HOME="C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot"
$env:Path="$env:JAVA_HOME\bin;$env:Path"
```

3. Verify the version:

```powershell
java -version
```

4. Run:

```powershell
cd C:\Test-Aria-Hardware\microbit-android
npx expo prebuild --platform android
npx expo run:android
```

If you see Gradle errors with class file major version 65, your installed Java is too new for Gradle 7.5.1. Switch to Java 17.
