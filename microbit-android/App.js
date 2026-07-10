/**
 * micro:bit Blue – React Native Edition
 * 
 * Based on the connection process and LED control code from:
 * https://github.com/microbit-foundation/microbit-blue
 * Original Author: Martin Woolley (@bluetooth_mdw)
 * Licensed under Apache License 2.0
 * 
 * Rewritten for React Native using react-native-ble-plx
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  PermissionsAndroid,
  Platform,
  ScrollView,
  TextInput,
  FlatList,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// ─── micro:bit BLE UUIDs (from BleAdapterService.java) ──────────────────────
// The microbit-blue project stores UUIDs without dashes as 32-char hex strings.
// Utility.normaliseUUID() inserts dashes: 8-4-4-4-12.
// react-native-ble-plx expects lowercase dashed UUIDs.

function normaliseUUID(uuid) {
  if (uuid.length === 4) {
    return `0000${uuid}-0000-1000-8000-00805f9b34fb`.toLowerCase();
  }
  if (uuid.length === 32) {
    return `${uuid.substring(0, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}-${uuid.substring(16, 20)}-${uuid.substring(20, 32)}`.toLowerCase();
  }
  return uuid.toLowerCase();
}

// LED Service
const LEDSERVICE_SERVICE_UUID = normaliseUUID('E95DD91D251D470AA062FA1922DFA9A8');
const LEDMATRIXSTATE_CHARACTERISTIC_UUID = normaliseUUID('E95D7B77251D470AA062FA1922DFA9A8');
const LEDTEXT_CHARACTERISTIC_UUID = normaliseUUID('E95D93EE251D470AA062FA1922DFA9A8');
const SCROLLINGDELAY_CHARACTERISTIC_UUID = normaliseUUID('E95D0D2D251D470AA062FA1922DFA9A8');

// IO Pin Service
const IOPINSERVICE_SERVICE_UUID = normaliseUUID('E95D127B251D470AA062FA1922DFA9A8');
const PINDATA_CHARACTERISTIC_UUID = normaliseUUID('E95D8D00251D470AA062FA1922DFA9A8');
const PINADCONFIGURATION_CHARACTERISTIC_UUID = normaliseUUID('E95D5899251D470AA062FA1922DFA9A8');
const PINIOCONFIGURATION_CHARACTERISTIC_UUID = normaliseUUID('E95DB9FE251D470AA062FA1922DFA9A8');

// Device Information Service (for keep-alive reads, same as microbit-blue)
const DEVICEINFORMATION_SERVICE_UUID = normaliseUUID('0000180A00001000800000805F9B34FB');
const FIRMWAREREVISIONSTRING_CHARACTERISTIC_UUID = normaliseUUID('00002A2600001000800000805F9B34FB');

// Connection keep-alive interval (from Constants.java: 10000ms)
const CONNECTION_KEEP_ALIVE_FREQUENCY = 10000;

// Scan timeout (from MainActivity.java: 30000)
const SCAN_TIMEOUT = 30000;

// Device name filter (from MainActivity.java: "BBC micro")
const DEVICE_NAME_START = 'BBC micro';

// ─── Connection States (mirrors microbit-blue flow) ──────────────────────────
const STATE_DISCONNECTED = 'Disconnected';
const STATE_SCANNING = 'Scanning...';
const STATE_CONNECTING = 'Connecting to micro:bit';
const STATE_DISCOVERING = 'Discovering services...';
const STATE_CONNECTED = 'Connected';

export default function App() {
  const managerRef = useRef(new BleManager());
  const keepAliveRef = useRef(null);
  const deviceRef = useRef(null);

  // ─── State ─────────────────────────────────────────────────────────────────
  const [connectionState, setConnectionState] = useState(STATE_DISCONNECTED);
  const [device, setDevice] = useState(null);
  const [scanResults, setScanResults] = useState([]); // [{id, name, rssi, bonded}]
  const [ledMatrix, setLedMatrix] = useState([0, 0, 0, 0, 0]); // 5 bytes, rows 1-5
  const [scrollText, setScrollText] = useState('');
  const [scrollingDelay, setScrollingDelay] = useState(120);
  const [logMessages, setLogMessages] = useState([]);
  const [servicesDiscovered, setServicesDiscovered] = useState(false);
  const [hasLedService, setHasLedService] = useState(false);
  const [hasIoPinService, setHasIoPinService] = useState(false);
  const [screenMode, setScreenMode] = useState('scan'); // 'scan' | 'analog'

  // ─── Logging (mirrors showMsg pattern) ─────────────────────────────────────
  const log = useCallback((msg, color = '#aaa') => {
    setLogMessages(prev => [{ text: msg, color, id: Date.now() + Math.random() }, ...prev].slice(0, 30));
  }, []);

  // ─── Lifecycle cleanup ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      managerRef.current.destroy();
    };
  }, []);

  // Sync deviceRef
  useEffect(() => { deviceRef.current = device; }, [device]);

  // ─── Permissions (from MainActivity.java) ──────────────────────────────────
  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    const perms = Platform.Version >= 31
      ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN || 'android.permission.BLUETOOTH_SCAN',
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT || 'android.permission.BLUETOOTH_CONNECT',
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE || 'android.permission.BLUETOOTH_ADVERTISE',
      ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

    try {
      const res = await PermissionsAndroid.requestMultiple(perms);
      const denied = Object.entries(res).filter(([_, v]) => v !== PermissionsAndroid.RESULTS.GRANTED).map(([k]) => k);
      if (denied.length > 0) {
        log('Permission not granted: ' + denied.join(', '), '#ff4444');
        return false;
      }
      log('Permissions granted', '#4CAF50');
      return true;
    } catch (e) {
      log('Permission error: ' + e.message, '#ff4444');
      return false;
    }
  };

  // ─── Keep-alive (from BleAdapterService.java KeepAlive class) ──────────────
  // Periodically reads firmware revision to prevent Android from dropping connection
  const startKeepAlive = useCallback((dev) => {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(async () => {
      try {
        if (deviceRef.current) {
          const isConn = await deviceRef.current.isConnected();
          if (isConn) {
            await deviceRef.current.readCharacteristicForService(
              DEVICEINFORMATION_SERVICE_UUID,
              FIRMWAREREVISIONSTRING_CHARACTERISTIC_UUID
            );
          }
        }
      } catch (_) { /* keep-alive read failed, connection may have dropped */ }
    }, CONNECTION_KEEP_ALIVE_FREQUENCY);
  }, []);

  const stopKeepAlive = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
  }, []);

  // ─── Scan (mirrors MainActivity.onScan / BleScanner flow) ──────────────────
  const startScan = async () => {
    const ok = await requestPermissions();
    if (!ok) return;

    setScanResults([]);
    setConnectionState(STATE_SCANNING);
    log('Scanning for micro:bits...', '#2196F3');

    const manager = managerRef.current;
    const found = new Map();

    manager.startDeviceScan(null, { allowDuplicates: false }, (error, scannedDevice) => {
      if (error) {
        log('Scan error: ' + error.message, '#ff4444');
        setConnectionState(STATE_DISCONNECTED);
        return;
      }
      if (!scannedDevice) return;

      const name = (scannedDevice.name || scannedDevice.localName || '');
      // Filter: name starts with "BBC micro" (same as microbit-blue DEVICE_NAME_START)
      if (name.startsWith(DEVICE_NAME_START) || name.toLowerCase().includes('micro:bit')) {
        if (!found.has(scannedDevice.id)) {
          found.set(scannedDevice.id, true);
          setScanResults(prev => [
            ...prev,
            {
              id: scannedDevice.id,
              name: name,
              rssi: scannedDevice.rssi,
              device: scannedDevice,
            },
          ]);
          log(`Found: ${name} (${scannedDevice.id})`, '#4CAF50');
        }
      }
    });

    // Auto-stop after SCAN_TIMEOUT (from MainActivity: 30s)
    setTimeout(() => {
      manager.stopDeviceScan();
      setConnectionState(prev => prev === STATE_SCANNING ? STATE_DISCONNECTED : prev);
      log('Scan complete', '#aaa');
    }, SCAN_TIMEOUT);
  };

  const stopScan = () => {
    managerRef.current.stopDeviceScan();
    setConnectionState(STATE_DISCONNECTED);
    log('Scan stopped', '#aaa');
  };

  // ─── Connect (mirrors MenuActivity.connectToDevice → GATT flow) ────────────
  // Flow: connect → GATT_CONNECTED → discoverServices → GATT_SERVICES_DISCOVERED → catalog services
  const connectToDevice = async (selectedDevice) => {
    managerRef.current.stopDeviceScan();
    setConnectionState(STATE_CONNECTING);
    log(`Connecting to ${selectedDevice.name}...`, '#2196F3');

    try {
      // Step 1: Connect (mirrors BleAdapterService.connect → onConnectionStateChange → GATT_CONNECTED)
      const connectedDev = await selectedDevice.device.connect({
        autoConnect: false
      });

      setConnectionState(STATE_DISCOVERING);
      log('Connected! Discovering services...', '#4CAF50');

      // Add a stabilization delay. Micro:bits can occasionally drop the connection if
      // service discovery begins too rapidly after the initial GATT connection completes.
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Step 2: Discover services
      const discoveredDev = await connectedDev.discoverAllServicesAndCharacteristics();
      setDevice(discoveredDev);



      // Step 3: Catalog services (mirrors MenuActivity handler for GATT_SERVICES_DISCOVERED)
      const services = await discoveredDev.services();
      const serviceUuids = services.map(s => s.uuid.toLowerCase());
      log(`Discovered ${services.length} services`, '#4CAF50');

      for (const svc of services) {
        log(`  Service: ${svc.uuid}`, '#888');
      }

      // Check for LED service (mirrors MicroBit.hasService(LEDSERVICE_SERVICE_UUID))
      const ledServicePresent = serviceUuids.includes(LEDSERVICE_SERVICE_UUID);
      setHasLedService(ledServicePresent);

      // Check for IO Pin service
      const ioPinServicePresent = serviceUuids.includes(IOPINSERVICE_SERVICE_UUID);
      setHasIoPinService(ioPinServicePresent);

      if (ledServicePresent) {
        log('LED Service available ✓', '#4CAF50');
      } else {
        log('LED Service NOT found on this micro:bit', '#ff4444');
      }

      if (ioPinServicePresent) {
        log('IO Pin Service available ✓', '#4CAF50');
      } else {
        log('IO Pin Service NOT found on this micro:bit', '#ff4444');
      }

      setServicesDiscovered(true);
      setConnectionState(STATE_CONNECTED);
      log('Ready', '#4CAF50');

      // Step 4: Start keep-alive (from BleAdapterService KeepAlive thread)
      startKeepAlive(discoveredDev);

      // Step 5: Read current LED matrix state (from LEDsActivity.onServiceConnected)
      if (ledServicePresent) {
        try {
          const matrixChar = await discoveredDev.readCharacteristicForService(
            LEDSERVICE_SERVICE_UUID,
            LEDMATRIXSTATE_CHARACTERISTIC_UUID
          );
          if (matrixChar.value) {
            const bytes = Buffer.from(matrixChar.value, 'base64');
            if (bytes.length >= 5) {
              setLedMatrix([bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]]);
              log('Read LED matrix state', '#4CAF50');
            }
          }
        } catch (e) {
          log('Could not read LED state: ' + e.message, '#FF9800');
        }

        // Read scrolling delay (from LEDsActivity handler)
        try {
          const delayChar = await discoveredDev.readCharacteristicForService(
            LEDSERVICE_SERVICE_UUID,
            SCROLLINGDELAY_CHARACTERISTIC_UUID
          );
          if (delayChar.value) {
            const bytes = Buffer.from(delayChar.value, 'base64');
            if (bytes.length >= 2) {
              const delay = (bytes[1] << 8) | bytes[0]; // little-endian (from Utility.shortFromLittleEndianBytes)
              setScrollingDelay(delay);
              log(`Scrolling delay: ${delay}ms`, '#888');
            }
          }
        } catch (e) {
          log('Could not read scrolling delay: ' + e.message, '#FF9800');
        }

        setScreenMode('analog');
      }

      // Monitor disconnection (mirrors onConnectionStateChange → GATT_DISCONNECT)
      discoveredDev.onDisconnected((error, dev) => {
        stopKeepAlive();
        setDevice(null);
        setServicesDiscovered(false);
        setHasLedService(false);
        setHasIoPinService(false);
        setConnectionState(STATE_DISCONNECTED);
        setScreenMode('scan');
        log('Disconnected', '#ff4444');
      });

    } catch (e) {
      setConnectionState(STATE_DISCONNECTED);
      const detailMsg = e.reason ? `(Reason: ${e.reason}, Code: ${e.errorCode})` : e.message;
      log('Connection failed: ' + detailMsg, '#ff4444');
    }
  };

  // ─── Disconnect (mirrors BleAdapterService.disconnect) ─────────────────────
  const disconnect = async () => {
    stopKeepAlive();
    if (device) {
      try { await device.cancelConnection(); } catch (_) { }
    }
    setDevice(null);
    setServicesDiscovered(false);
    setHasLedService(false);
    setHasIoPinService(false);
    setConnectionState(STATE_DISCONNECTED);
    setScreenMode('scan');
    log('Disconnected', '#ff4444');
  };

  // ─── LED Matrix Control (from LEDsActivity) ───────────────────────────────
  // The LED matrix is a 5×5 grid where each row is a byte.
  // Bit layout per row: bit4=LED1, bit3=LED2, bit2=LED3, bit1=LED4, bit0=LED5
  // (from LEDsActivity comments:
  //   Octet 0, LED Row 1: bit4 bit3 bit2 bit1 bit0
  //   Octet 1, LED Row 2: ...etc)

  const toggleLed = (row, col) => {
    // col 0 = bit4, col 1 = bit3, ... col 4 = bit0 (from LEDsActivity.onTouch)
    const bitPos = 4 - col;
    setLedMatrix(prev => {
      const next = [...prev];
      if ((next[row] & (1 << bitPos)) !== 0) {
        next[row] = next[row] & ~(1 << bitPos);
      } else {
        next[row] = next[row] | (1 << bitPos);
      }
      return next;
    });
  };

  const isLedOn = (row, col) => {
    const bitPos = 4 - col;
    return (ledMatrix[row] & (1 << bitPos)) !== 0;
  };

  // Write LED matrix to micro:bit (from LEDsActivity.onSetDisplay)
  const writeLedMatrix = async () => {
    if (!device) { log('Not connected', '#ff4444'); return; }
    const bytes = new Uint8Array(ledMatrix);
    const b64 = Buffer.from(bytes).toString('base64');
    try {
      await device.writeCharacteristicWithResponseForService(
        LEDSERVICE_SERVICE_UUID,
        LEDMATRIXSTATE_CHARACTERISTIC_UUID,
        b64
      );
      log('LED matrix updated', '#4CAF50');
    } catch (e) {
      log('Write error: ' + e.message, '#ff4444');
    }
  };

  // Send scrolling text (from LEDsActivity.onSendText)
  const sendScrollText = async () => {
    if (!device) { log('Not connected', '#ff4444'); return; }
    if (!scrollText.trim()) { log('Enter text to display', '#FF9800'); return; }
    try {
      const utf8Bytes = Buffer.from(scrollText, 'utf-8');
      const b64 = utf8Bytes.toString('base64');
      await device.writeCharacteristicWithResponseForService(
        LEDSERVICE_SERVICE_UUID,
        LEDTEXT_CHARACTERISTIC_UUID,
        b64
      );
      log(`Sent text: "${scrollText}"`, '#4CAF50');
    } catch (e) {
      log('Text write error: ' + e.message, '#ff4444');
    }
  };

  // Write scrolling delay (from LEDsActivity.onActivityResult for settings change)
  const writeScrollingDelay = async (delay) => {
    if (!device) return;
    // Little-endian 2 bytes (from Utility.leBytesFromShort)
    const bytes = new Uint8Array(2);
    bytes[0] = delay & 0xff;
    bytes[1] = (delay >> 8) & 0xff;
    const b64 = Buffer.from(bytes).toString('base64');
    try {
      await device.writeCharacteristicWithResponseForService(
        LEDSERVICE_SERVICE_UUID,
        SCROLLINGDELAY_CHARACTERISTIC_UUID,
        b64
      );
      log(`Scrolling delay set to ${delay}ms`, '#4CAF50');
    } catch (e) {
      log('Delay write error: ' + e.message, '#ff4444');
    }
  };

  // Direct write of a specific matrix array (avoids stale closure in patterns)
  const writeMatrixDirect = async (matrix) => {
    if (!device) { log('Not connected', '#ff4444'); return; }
    const bytes = new Uint8Array(matrix);
    const b64 = Buffer.from(bytes).toString('base64');
    try {
      await device.writeCharacteristicWithResponseForService(
        LEDSERVICE_SERVICE_UUID,
        LEDMATRIXSTATE_CHARACTERISTIC_UUID,
        b64
      );
      log('LED matrix updated', '#4CAF50');
    } catch (e) {
      log('Write error: ' + e.message, '#ff4444');
    }
  };

  // Set pattern and write immediately
  const applyPattern = (matrix) => {
    setLedMatrix(matrix);
    writeMatrixDirect(matrix);
  };

  // Convenience: all LEDs on
  const allLedsOn = () => applyPattern([31, 31, 31, 31, 31]);
  // Convenience: all LEDs off
  const allLedsOff = () => applyPattern([0, 0, 0, 0, 0]);

  // ─── IO Pin Analog Output Control ─────────────────────────────────────────────
  // Configure pin 0 for analog output
  const configurePin0AnalogOutput = async () => {
    if (!device) { log('Not connected', '#ff4444'); return false; }

    try {
      // Configure pin 0 as analog (set bit 0 in PINADCONFIGURATION)
      const adFlags = new Uint8Array([0x01]); // bit 0 = analog for pin 0
      const adB64 = Buffer.from(adFlags).toString('base64');
      await device.writeCharacteristicWithResponseForService(
        IOPINSERVICE_SERVICE_UUID,
        PINADCONFIGURATION_CHARACTERISTIC_UUID,
        adB64
      );

      // Configure pin 0 as output (clear bit 0 in PINIOCONFIGURATION - 0 = output)
      const ioFlags = new Uint8Array([0x00]); // bit 0 = 0 = output for pin 0
      const ioB64 = Buffer.from(ioFlags).toString('base64');
      await device.writeCharacteristicWithResponseForService(
        IOPINSERVICE_SERVICE_UUID,
        PINIOCONFIGURATION_CHARACTERISTIC_UUID,
        ioB64
      );

      log('Pin 0 configured for analog output', '#4CAF50');
      return true;
    } catch (e) {
      log('Pin configuration error: ' + e.message, '#ff4444');
      return false;
    }
  };

  // Write analog value to pin 0 (0-1023)
  const writeAnalogValue = async (value) => {
    if (!device) { log('Not connected', '#ff4444'); return; }

    try {
      // Format: [pin_number (uint8), value (uint16 little endian)]
      const bytes = new Uint8Array(3);
      bytes[0] = 0x00; // pin 0
      bytes[1] = value & 0xff; // low byte
      bytes[2] = (value >> 8) & 0xff; // high byte
      const b64 = Buffer.from(bytes).toString('base64');
      await device.writeCharacteristicWithResponseForService(
        IOPINSERVICE_SERVICE_UUID,
        PINDATA_CHARACTERISTIC_UUID,
        b64
      );
      log(`Pin 0 analog value set to ${value}`, '#4CAF50');
    } catch (e) {
      log('Analog write error: ' + e.message, '#ff4444');
    }
  };

  // Set pin 0 to maximum (1023)
  const setPin0Max = async () => {
    const configured = await configurePin0AnalogOutput();
    if (configured) {
      await writeAnalogValue(1023);
    }
  };

  // Set pin 0 to minimum (0)
  const setPin0Min = async () => {
    const configured = await configurePin0AnalogOutput();
    if (configured) {
      await writeAnalogValue(0);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  const isConnected = connectionState === STATE_CONNECTED;
  const isScanning = connectionState === STATE_SCANNING;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0e1a" />
      <ScrollView contentContainerStyle={styles.container}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={styles.headerEmoji}>📡</Text>
          <Text style={styles.headerTitle}>micro:bit Blue</Text>
          <Text style={styles.headerSubtitle}>BLE Analog Controller</Text>
        </View>

        {/* ── Connection Status Card ──────────────────────────────────── */}
        <View style={styles.statusCard}>
          <View style={styles.statusDot}>
            <View style={[
              styles.dot,
              { backgroundColor: isConnected ? '#4CAF50' : isScanning ? '#FFC107' : '#ff4444' }
            ]} />
          </View>
          <View style={styles.statusInfo}>
            <Text style={styles.statusLabel}>{connectionState}</Text>
            <Text style={styles.statusDevice}>
              {device ? (device.name || device.id) : 'No device'}
            </Text>
          </View>
          {isConnected && (
            <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
              <Text style={styles.disconnectBtnText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Tab Switcher ────────────────────────────────────────────── */}
        {isConnected && (
          <View style={styles.tabBar}>
            <TouchableOpacity
              style={[styles.tab, screenMode === 'scan' && styles.tabActive]}
              onPress={() => setScreenMode('scan')}>
              <Text style={[styles.tabText, screenMode === 'scan' && styles.tabTextActive]}>Scan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, screenMode === 'analog' && styles.tabActive]}
              onPress={() => setScreenMode('analog')}>
              <Text style={[styles.tabText, screenMode === 'analog' && styles.tabTextActive]}>Analog</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════ */}
        {/* ── SCAN SCREEN (mirrors MainActivity) ───────────────────── */}
        {/* ════════════════════════════════════════════════════════════ */}
        {screenMode === 'scan' && (
          <View style={styles.section}>
            <TouchableOpacity
              style={[styles.primaryBtn, isScanning && styles.scanningBtn]}
              onPress={isScanning ? stopScan : startScan}
              disabled={isConnected}>
              {isScanning && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
              <Text style={styles.primaryBtnText}>
                {isScanning ? 'Stop Scanning' : 'Find BBC micro:bit(s)'}
              </Text>
            </TouchableOpacity>

            {scanResults.length > 0 && (
              <View style={styles.deviceListCard}>
                <Text style={styles.sectionTitle}>Discovered Devices</Text>
                {scanResults.map(item => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.deviceRow}
                    onPress={() => connectToDevice(item)}
                    disabled={connectionState !== STATE_DISCONNECTED && connectionState !== STATE_SCANNING}>
                    <View style={styles.deviceIcon}>
                      <Text style={{ fontSize: 20 }}>🔲</Text>
                    </View>
                    <View style={styles.deviceInfo}>
                      <Text style={styles.deviceName}>{item.name}</Text>
                      <Text style={styles.deviceAddr}>{item.id}</Text>
                    </View>
                    <Text style={styles.deviceRssi}>{item.rssi} dBm</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {scanResults.length === 0 && !isScanning && connectionState === STATE_DISCONNECTED && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyEmoji}>📱</Text>
                <Text style={styles.emptyText}>Tap "Find" to scan for nearby micro:bits</Text>
                <Text style={styles.emptyHint}>
                  Make sure your micro:bit is paired and within range
                </Text>
              </View>
            )}

            {(connectionState === STATE_CONNECTING || connectionState === STATE_DISCOVERING) && (
              <View style={styles.connectingOverlay}>
                <ActivityIndicator color="#6366f1" size="large" />
                <Text style={styles.connectingText}>{connectionState}</Text>
              </View>
            )}
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════ */}
        {/* ── ANALOG OUTPUT SCREEN ─────────────────────────────────── */}
        {/* ════════════════════════════════════════════════════════════ */}
        {screenMode === 'analog' && isConnected && (
          <View style={styles.section}>

            {!hasIoPinService ? (
              <View style={styles.warningCard}>
                <Text style={styles.warningText}>⚠️ IO Pin Service not available on this micro:bit</Text>
                <Text style={styles.warningHint}>Make sure you're using the DAL hex file with IO Pin Service enabled</Text>
              </View>
            ) : (
              <>
                {/* ── Pin 0 Analog Output Control ── */}
                <Text style={styles.sectionTitle}>Pin 0 Analog Output</Text>
                <View style={styles.analogControlCard}>
                  <View style={styles.pinInfo}>
                    <Text style={styles.pinLabel}>Pin 0</Text>
                    <Text style={styles.pinDescription}>Analog output (0-1023)</Text>
                  </View>

                  <View style={styles.analogButtons}>
                    <TouchableOpacity 
                      style={[styles.analogBtn, styles.analogBtnOn]} 
                      onPress={setPin0Max}>
                      <Text style={styles.analogBtnText}>ON (1023)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                      style={[styles.analogBtn, styles.analogBtnOff]} 
                      onPress={setPin0Min}>
                      <Text style={styles.analogBtnText}>OFF (0)</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.analogInfo}>
                    <Text style={styles.analogInfoText}>
                      Press ON to set pin 0 to maximum analog value (1023)
                    </Text>
                    <Text style={styles.analogInfoText}>
                      Press OFF to set pin 0 to minimum analog value (0)
                    </Text>
                  </View>
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Console Log (mirrors message display in microbit-blue) ── */}
        <View style={styles.consoleCard}>
          <Text style={styles.consoleTitle}>Console</Text>
          <ScrollView
            style={styles.consoleScroll}
            contentContainerStyle={styles.consoleScrollContent}
            nestedScrollEnabled={true}>
            {logMessages.map(msg => (
              <Text key={msg.id} style={[styles.consoleMsg, { color: msg.color }]}>
                {msg.text}
              </Text>
            ))}
            {logMessages.length === 0 && (
              <Text style={styles.consolePlaceholder}>No messages yet</Text>
            )}
          </ScrollView>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0e1a',
  },
  container: {
    padding: 16,
    paddingBottom: 40,
  },

  // Header
  header: {
    alignItems: 'center',
    paddingVertical: 20,
    marginBottom: 8,
  },
  headerEmoji: { fontSize: 36, marginBottom: 6 },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#e8eaed',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#6366f1',
    fontWeight: '600',
    marginTop: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Status card
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#12162a',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  statusDot: { marginRight: 12 },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  statusInfo: { flex: 1 },
  statusLabel: { fontSize: 15, fontWeight: '700', color: '#e8eaed' },
  statusDevice: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  disconnectBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,68,68,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disconnectBtnText: { color: '#ff4444', fontSize: 16, fontWeight: '700' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#12162a',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabActive: {
    backgroundColor: '#6366f1',
  },
  tabText: { fontSize: 14, fontWeight: '600', color: '#6b7280' },
  tabTextActive: { color: '#fff' },

  // Sections
  section: { marginBottom: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6366f1',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 12,
    marginLeft: 4,
  },

  // Primary button
  primaryBtn: {
    flexDirection: 'row',
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: '#6366f1',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  scanningBtn: { backgroundColor: '#FF9800' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Device list
  deviceListCard: {
    backgroundColor: '#12162a',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e2340',
  },
  deviceIcon: { marginRight: 12 },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 15, fontWeight: '700', color: '#e8eaed' },
  deviceAddr: { fontSize: 11, color: '#6b7280', marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  deviceRssi: { fontSize: 12, color: '#6366f1', fontWeight: '600' },

  // Empty state
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, color: '#6b7280', fontWeight: '600' },
  emptyHint: { fontSize: 12, color: '#444', marginTop: 6, textAlign: 'center' },

  // Connecting overlay
  connectingOverlay: { alignItems: 'center', paddingVertical: 40 },
  connectingText: { color: '#6366f1', fontSize: 16, fontWeight: '600', marginTop: 12 },

  // Warning
  warningCard: {
    backgroundColor: 'rgba(255,152,0,0.1)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,152,0,0.3)',
  },
  warningText: { color: '#FF9800', fontSize: 14, fontWeight: '600' },
  warningHint: { color: '#FFB74D', fontSize: 12, marginTop: 4 },

  // Analog control card
  analogControlCard: {
    backgroundColor: '#12162a',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  pinInfo: {
    alignItems: 'center',
    marginBottom: 20,
  },
  pinLabel: {
    fontSize: 24,
    fontWeight: '800',
    color: '#e8eaed',
  },
  pinDescription: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 4,
  },
  analogButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  analogBtn: {
    flex: 1,
    paddingVertical: 18,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  analogBtnOn: {
    backgroundColor: '#4CAF50',
  },
  analogBtnOff: {
    backgroundColor: '#ff4444',
  },
  analogBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  analogInfo: {
    backgroundColor: 'rgba(99,102,241,0.1)',
    borderRadius: 8,
    padding: 12,
  },
  analogInfoText: {
    color: '#6366f1',
    fontSize: 12,
    lineHeight: 18,
  },

  // LED grid
  ledGridCard: {
    backgroundColor: '#12162a',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  ledGrid: { marginBottom: 16 },
  ledRow: { flexDirection: 'row' },
  ledCell: {
    width: 52,
    height: 52,
    margin: 3,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ledOn: { backgroundColor: 'rgba(239,68,68,0.15)' },
  ledOff: { backgroundColor: 'rgba(255,255,255,0.04)' },
  ledDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  ledDotOn: {
    backgroundColor: '#ef4444',
    shadowColor: '#ef4444',
    shadowOpacity: 0.8,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  ledDotOff: {
    backgroundColor: '#2a2e42',
    borderWidth: 1,
    borderColor: '#3a3e52',
  },

  // Matrix actions
  matrixActions: {
    flexDirection: 'row',
    width: '100%',
    gap: 8,
  },
  actionBtn: {
    flex: 2,
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  actionBtnSecondary: {
    flex: 1,
    backgroundColor: 'rgba(99,102,241,0.12)',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.25)',
  },
  actionBtnSecondaryText: { color: '#6366f1', fontSize: 13, fontWeight: '700' },

  // Text input
  textCard: {
    flexDirection: 'row',
    backgroundColor: '#12162a',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  textInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#e8eaed',
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Delay control
  delayCard: {
    backgroundColor: '#12162a',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  delayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  delayBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(99,102,241,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.25)',
  },
  delayBtnText: { color: '#6366f1', fontSize: 24, fontWeight: '700' },
  delayValue: {
    color: '#e8eaed',
    fontSize: 18,
    fontWeight: '700',
    marginHorizontal: 24,
    minWidth: 80,
    textAlign: 'center',
  },

  // Patterns
  patternsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  patternBtn: {
    flex: 1,
    backgroundColor: '#12162a',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e2340',
  },
  patternEmoji: { fontSize: 24, marginBottom: 4 },
  patternLabel: { fontSize: 11, color: '#6b7280', fontWeight: '600' },

  // Console
  consoleCard: {
    backgroundColor: '#0d1117',
    borderRadius: 14,
    padding: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#1e2340',
    height: 200,
    overflow: 'hidden',
  },
  consoleScroll: {
    flex: 1,
  },
  consoleScrollContent: {
    paddingBottom: 8,
  },
  consoleTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#444',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  consoleMsg: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 3,
  },
  consolePlaceholder: { fontSize: 12, color: '#333' },
});
