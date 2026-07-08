import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { UsbSerialManager, Parity } from 'react-native-usb-serialport-for-android';
import { stringToHex } from './src/usbSerial';

const BAUD_RATE = 9600;
const PERMISSION_WAIT_MS = 4000;
const DEVICE_STATUS = {
  DISCONNECTED: 'Disconnected',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected',
  ERROR: 'Error',
};

const waitForUsbPermission = async (deviceId, timeoutMs = PERMISSION_WAIT_MS) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const hasPermission = await UsbSerialManager.hasPermission(deviceId);
    if (hasPermission) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
};

export default function App() {
  const [status, setStatus] = useState(DEVICE_STATUS.DISCONNECTED);
  const [error, setError] = useState('');
  const [deviceId, setDeviceId] = useState(null);
  const [serialPort, setSerialPort] = useState(null);
  const [isBusy, setIsBusy] = useState(false);

  const statusColor = useMemo(() => {
    switch (status) {
      case DEVICE_STATUS.CONNECTING:
        return '#f59e0b';
      case DEVICE_STATUS.CONNECTED:
        return '#16a34a';
      case DEVICE_STATUS.ERROR:
        return '#dc2626';
      default:
        return '#6b7280';
    }
  }, [status]);

  // Discover every attached USB serial device, ask for permission if needed,
  // and open the first Arduino-compatible port at 9600 baud.
  const handleConnect = async () => {
    try {
      setIsBusy(true);
      setStatus(DEVICE_STATUS.CONNECTING);
      setError('');

      const devices = await UsbSerialManager.list();
      if (!devices?.length) {
        throw new Error('No USB serial devices were detected.');
      }

      const arduinoDevice = devices.find((device) => device.vendorId === 9025) || devices[0];
      if (!arduinoDevice) {
        throw new Error('No compatible Arduino USB device was found.');
      }

      const hasPermission = await UsbSerialManager.hasPermission(arduinoDevice.deviceId);
      if (!hasPermission) {
        await UsbSerialManager.tryRequestPermission(arduinoDevice.deviceId);
        const granted = await waitForUsbPermission(arduinoDevice.deviceId);
        if (!granted) {
          throw new Error('USB permission was not granted in time. Please approve the prompt and try again.');
        }
      }

      const port = await UsbSerialManager.open(arduinoDevice.deviceId, {
        baudRate: BAUD_RATE,
        parity: Parity.None,
        dataBits: 8,
        stopBits: 1,
      });

      setSerialPort(port);
      setDeviceId(arduinoDevice.deviceId);
      setStatus(DEVICE_STATUS.CONNECTED);
    } catch (err) {
      setStatus(DEVICE_STATUS.ERROR);
      setError(err?.message || 'Unable to connect to the Arduino device.');
      console.error(err);
    } finally {
      setIsBusy(false);
    }
  };

  // Send the exact newline-delimited command expected by the Arduino sketch.
  const sendCommand = async (command) => {
    if (!serialPort) {
      Alert.alert('Connection Required', 'Connect to the Arduino before sending a command.');
      return;
    }

    try {
      await serialPort.send(stringToHex(`${command}\n`));
    } catch (err) {
      setStatus(DEVICE_STATUS.ERROR);
      setError(err?.message || `Unable to send ${command}.`);
      console.error(err);
    }
  };

  const handleDisconnect = async () => {
    if (!serialPort) {
      setStatus(DEVICE_STATUS.DISCONNECTED);
      setError('');
      return;
    }

    try {
      await serialPort.close();
      setSerialPort(null);
      setDeviceId(null);
      setStatus(DEVICE_STATUS.DISCONNECTED);
      setError('');
    } catch (err) {
      setStatus(DEVICE_STATUS.ERROR);
      setError(err?.message || 'Unable to close the serial connection.');
      console.error(err);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.card}>
        <Text style={styles.title}>Arduino USB LED Control</Text>
        <Text style={styles.subtitle}>Control an Arduino Uno over USB serial with Android OTG.</Text>

        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Status</Text>
          <View style={[styles.statusBadge, { backgroundColor: `${statusColor}22` }] }>
            {isBusy ? <ActivityIndicator size="small" color={statusColor} /> : null}
            <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
          </View>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable style={styles.primaryButton} onPress={handleConnect} disabled={isBusy}>
          <Text style={styles.buttonText}>{isBusy ? 'Connecting...' : 'Connect Arduino'}</Text>
        </Pressable>

        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryButton} onPress={() => sendCommand('ON')}>
            <Text style={styles.buttonText}>LED ON</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => sendCommand('OFF')}>
            <Text style={styles.buttonText}>LED OFF</Text>
          </Pressable>
        </View>

        <Pressable style={styles.ghostButton} onPress={handleDisconnect}>
          <Text style={styles.ghostButtonText}>Disconnect</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#111827',
    borderRadius: 24,
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusLabel: {
    color: '#f8fafc',
    fontWeight: '600',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    gap: 8,
  },
  statusText: {
    fontWeight: '700',
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#1f2937',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  buttonText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  ghostButtonText: {
    color: '#cbd5e1',
    fontWeight: '600',
  },
});
