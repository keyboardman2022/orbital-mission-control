#include <jni.h>
#include <cstdlib>
#include <string>
#include <vector>
#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_com_orbital_offline_OfflineRuntime_nativeStart(
    JNIEnv* env, jclass, jobjectArray arguments, jstring temporary_directory) {
    const char* temporary = env->GetStringUTFChars(temporary_directory, nullptr);
    if (!temporary) return 1;
    setenv("TMPDIR", temporary, 1);
    env->ReleaseStringUTFChars(temporary_directory, temporary);

    const jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> values;
    values.reserve(count);
    for (jsize i = 0; i < count; ++i) {
        auto argument = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char* value = env->GetStringUTFChars(argument, nullptr);
        if (!value) return 1;
        values.emplace_back(value);
        env->ReleaseStringUTFChars(argument, value);
        env->DeleteLocalRef(argument);
    }
    // Keep argv strings in one buffer as in the Android Node embedder.
    std::size_t bytes = 0;
    for (const auto& value : values) bytes += value.size() + 1;
    std::vector<char> storage;
    storage.reserve(bytes);
    std::vector<char*> argv;
    argv.reserve(count + 1);
    for (const auto& value : values) {
        const std::size_t offset = storage.size();
        storage.insert(storage.end(), value.begin(), value.end());
        storage.push_back('\0');
        argv.push_back(storage.data() + offset);
    }
    argv.push_back(nullptr);
    return node::Start(count, argv.data());
}
