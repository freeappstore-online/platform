# No reflection-based serialization: the wire format is explicit JSONObject mapping.
# sherpa-onnx's JNI reads its Kotlin config classes' fields by name (#731); its AAR ships no consumer rules.
-keep class com.k2fsa.sherpa.onnx.** { *; }
-keep class online.freeappstore.companion.TtsCallback { public java.lang.Integer invoke(float[]); }
