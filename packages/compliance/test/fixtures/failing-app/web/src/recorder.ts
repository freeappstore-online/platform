// Rigged for the "Permissions declared" check (#285): uses the microphone without declaring it.
export function record() {
  return navigator.mediaDevices.getUserMedia({ audio: true });
}
