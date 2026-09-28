package com.omninovel.mobile

import android.os.Build
import android.os.StatFs
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity: FlutterActivity() {
    private val DISK_SPACE_CHANNEL = "com.omninovel.mobile/disk_space"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DISK_SPACE_CHANNEL).setMethodCallHandler { call, result ->
            if (call.method == "getFreeDiskSpace") {
                val path = call.argument<String>("path") ?: context.filesDir.absolutePath
                try {
                    val file = File(path)
                    val targetDir = if (file.exists()) {
                        if (file.isDirectory) file else file.parentFile ?: context.filesDir
                    } else {
                        file.parentFile ?: context.filesDir
                    }
                    val stat = StatFs(targetDir.absolutePath)
                    val availableBytes: Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
                        stat.availableBytes
                    } else {
                        @Suppress("DEPRECATION")
                        stat.availableBlocks.toLong() * stat.blockSize.toLong()
                    }
                    result.success(availableBytes)
                } catch (e: Exception) {
                    result.error("STATFS_ERROR", "Failed to retrieve available disk space: ${e.message}", null)
                }
            } else {
                result.notImplemented()
            }
        }
    }
}
