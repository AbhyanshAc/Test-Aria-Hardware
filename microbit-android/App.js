import React, {useState, useEffect, useRef} from 'react';
import {SafeAreaView, View, Text, TouchableOpacity, StyleSheet, Alert, PermissionsAndroid, Platform, ScrollView} from 'react-native';
import {BleManager} from 'react-native-ble-plx';
import {Buffer} from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

const LED_SERVICE_UUID = 'E95DD91D-251D-470A-A062-FA1922DFA9A8'.toLowerCase();
const LED_MATRIX_CHAR = 'E95D7B77-251D-470A-A062-FA1922DFA9A8'.toLowerCase();

export default function App() {
  const managerRef = useRef(new BleManager());
  const [device, setDevice] = useState(null);
  const [connected, setConnected] = useState(false);
  const [ledOn, setLedOn] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    return () => {
      managerRef.current.destroy();
    };
  }, []);

  const requestAndroidPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    const bluetoothScan = PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN || 'android.permission.BLUETOOTH_SCAN';
    const bluetoothConnect = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT || 'android.permission.BLUETOOTH_CONNECT';
    const bluetoothAdvertise = PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE || 'android.permission.BLUETOOTH_ADVERTISE';

    const perms = Platform.Version >= 31
      ? [bluetoothScan, bluetoothConnect, bluetoothAdvertise]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

    try {
      const res = await PermissionsAndroid.requestMultiple(perms);
      const denied = Object.entries(res)
        .filter(([_, value]) => value !== PermissionsAndroid.RESULTS.GRANTED)
        .map(([key]) => key);
      const ok = denied.length === 0;
      if (!ok) {
        Alert.alert('Permissions', `Required permissions not granted: ${denied.join(', ')}`);
      }
      return ok;
    } catch (e) {
      Alert.alert('Permission error', e.message);
      return false;
    }
  };

  const scanAndConnect = async () => {
    const ok = await requestAndroidPermissions();
    if (!ok) return;
    const manager = managerRef.current;
    setDevice(null);
    setConnected(false);
    setScanning(true);
    manager.startDeviceScan(null, null, (error, scannedDevice) => {
      if (error) {
        Alert.alert('Scan error', error.message);
        setScanning(false);
        return;
      }
      if (!scannedDevice) return;
      const name = (scannedDevice.name || scannedDevice.localName || '').toLowerCase();
      const hasService = scannedDevice.serviceUUIDs && scannedDevice.serviceUUIDs.map(s=>s.toLowerCase()).includes(LED_SERVICE_UUID);
      if (name.includes('micro:bit') || hasService) {
        manager.stopDeviceScan();
        setScanning(false);
        scannedDevice.connect()
          .then(d => d.discoverAllServicesAndCharacteristics())
          .then(d => {
            setDevice(d);
            setConnected(true);
            Alert.alert('Connected', d.name || d.id);
          })
          .catch(e => Alert.alert('Connect error', e.message));
      }
    });
    // Stop scan after 12s
    setTimeout(() => { manager.stopDeviceScan(); setScanning(false); }, 12000);
  };

  const writeLedMatrix = async (on) => {
    if (!device) { Alert.alert('Not connected'); return; }
    const bytes = on ? new Uint8Array([31,31,31,31,31]) : new Uint8Array([0,0,0,0,0]);
    const b64 = Buffer.from(bytes).toString('base64');
    try {
      await device.writeCharacteristicWithResponseForService(LED_SERVICE_UUID, LED_MATRIX_CHAR, b64);
      setLedOn(on);
    } catch (e) {
      Alert.alert('Write error', e.message);
    }
  };

  const disconnect = async () => {
    if (!device) return;
    try { await device.cancelConnection(); } catch (_) {}
    setDevice(null); setConnected(false);
  };

  return (
    <SafeAreaView style={{flex:1}}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>micro:bit LED Control (Android)</Text>

        <View style={styles.buttonGrid}>
          <TouchableOpacity style={[styles.actionButton, scanning && styles.disabledButton]} onPress={() => connected ? disconnect() : scanAndConnect()} disabled={false}>
            <Text style={styles.buttonText}>{connected ? 'Disconnect' : (scanning ? 'Scanning...' : 'Scan & Connect')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.actionButton, !connected && styles.disabledButton]} onPress={() => writeLedMatrix(!ledOn)} disabled={!connected}>
            <Text style={styles.buttonText}>{ledOn ? 'Turn LEDs Off' : 'Turn LEDs On'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.actionButton, !connected && styles.disabledButton]} onPress={async () => {
            if (!connected) { Alert.alert('Not connected'); return; }
            for (let i=0;i<3;i++) { await writeLedMatrix(true); await new Promise(r=>setTimeout(r,300)); await writeLedMatrix(false); await new Promise(r=>setTimeout(r,300)); }
          }} disabled={!connected}>
            <Text style={styles.buttonText}>Flicker (3x)</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.actionButton, !connected && styles.disabledButton]} onPress={() => writeLedMatrix(false)} disabled={!connected}>
            <Text style={styles.buttonText}>Turn All Off</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statusCard}>
          <View style={styles.statusRow}><Text style={styles.statusLabel}>Connected</Text><Text style={styles.statusValue}>{connected ? 'Yes' : 'No'}</Text></View>
          <View style={styles.statusRow}><Text style={styles.statusLabel}>Device</Text><Text style={styles.statusValue}>{device ? (device.name || device.id) : '—'}</Text></View>
          <View style={styles.statusRow}><Text style={styles.statusLabel}>LED state</Text><Text style={styles.statusValue}>{ledOn ? 'ON' : 'OFF'}</Text></View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 20,
    backgroundColor: '#f6f7fb',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 20,
    color: '#1f2937',
  },
  buttonGrid: {
    width: '100%',
    marginTop: 8,
  },
  actionButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    marginBottom: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 2},
    elevation: 3,
  },
  disabledButton: {
    backgroundColor: '#94a3b8',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  statusCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 18,
    marginTop: 24,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  statusLabel: {
    fontSize: 15,
    color: '#475569',
  },
  statusValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
});
