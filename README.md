# Test-Aria-Hardware:
A Test Code made to test USB Serial Communication between Android and Arduino, and also testing Communication using BLE for BBC:MicroBit V1 while using Expo

# Arduino Sketch:
const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "ON")
      digitalWrite(LED, HIGH);

    if (cmd == "OFF")
      digitalWrite(LED, LOW);
  }
}
