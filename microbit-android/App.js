import React, {useState, useEffect, useRef} from 'react';
import {SafeAreaView, View, Text, Button, StyleSheet, Alert, PermissionsAndroid, Platform, ScrollView} from 'react-native';
import {BleManager} from 'react-native-ble-plx';
import {Buffer} from 'buffer';

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
    const perms = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    // Android 12+ needs BLUETOOTH_SCAN / BLUETOOTH_CONNECT runtime permissions
    if (Platform.Version >= 31) {
      perms.push('android.permission.BLUETOOTH_SCAN');
      perms.push('android.permission.BLUETOOTH_CONNECT');
    }
    try {
      const res = await PermissionsAndroid.requestMultiple(perms);
      const ok = Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
      if (!ok) Alert.alert('Permissions', 'Required permissions not granted');
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

        <View style={styles.row}>
          <Button title={connected ? 'Disconnect' : (scanning ? 'Scanning...' : 'Scan & Connect')} onPress={() => connected ? disconnect() : scanAndConnect()} />
        </View>

        <View style={styles.row}>
          <Button title={ledOn ? 'Turn LEDs Off' : 'Turn LEDs On'} onPress={() => writeLedMatrix(!ledOn)} disabled={!connected} />
        </View>

        <View style={styles.row}>
          <Button title="Flicker (3x)" onPress={async () => {
            if (!connected) { Alert.alert('Not connected'); return; }
            for (let i=0;i<3;i++) { await writeLedMatrix(true); await new Promise(r=>setTimeout(r,300)); await writeLedMatrix(false); await new Promise(r=>setTimeout(r,300)); }
          }} disabled={!connected} />
        </View>

        <View style={styles.row}>
          <Button title="Turn All Off" onPress={() => writeLedMatrix(false)} disabled={!connected} />
        </View>

        <View style={{marginTop:20}}>
          <Text>Connected: {connected ? 'yes' : 'no'}</Text>
          <Text>Device: {device ? (device.name || device.id) : '—'}</Text>
          <Text>LED state: {ledOn ? 'ON' : 'OFF'}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {alignItems:'center', justifyContent:'flex-start', padding:20},
  title: {fontSize:18, fontWeight:'600', marginBottom:16},
  row: {width:'100%', marginVertical:8}
});
