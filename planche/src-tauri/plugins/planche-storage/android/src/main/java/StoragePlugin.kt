package com.planche.storage

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SaveDocumentArgs {
    lateinit var name: String
    lateinit var mimeType: String
    lateinit var content: String
}

/**
 * System pickers (Storage Access Framework). Picked folders and files keep a
 * persistable read grant, so the library can read them again after a
 * restart; the app reads them by URI through the ContentResolver.
 */
@TauriPlugin
class StoragePlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingContent: String? = null

    @Command
    fun pickFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
        startActivityForResult(invoke, intent, "folderPicked")
    }

    @ActivityCallback
    fun folderPicked(invoke: Invoke, result: ActivityResult) {
        val tree = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || tree == null) {
            invoke.reject("cancelled")
            return
        }
        keepReadAccess(tree)
        // The tree's root as a document: its children are listed from there.
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        invoke.resolve(picked(root))
    }

    @Command
    fun pickFile(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        startActivityForResult(invoke, intent, "filePicked")
    }

    @ActivityCallback
    fun filePicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.reject("cancelled")
            return
        }
        keepReadAccess(uri)
        invoke.resolve(picked(uri))
    }

    /** Asks where to save, then writes `content` there (annotation exports). */
    @Command
    fun saveDocument(invoke: Invoke) {
        val args = invoke.parseArgs(SaveDocumentArgs::class.java)
        pendingContent = args.content
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(args.mimeType)
            .putExtra(Intent.EXTRA_TITLE, args.name)
        startActivityForResult(invoke, intent, "documentCreated")
    }

    @ActivityCallback
    fun documentCreated(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        val content = pendingContent
        pendingContent = null
        if (result.resultCode != Activity.RESULT_OK || uri == null || content == null) {
            invoke.reject("cancelled")
            return
        }
        try {
            activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                ?: throw IllegalStateException("cannot open the document")
            invoke.resolve(picked(uri))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "write failed")
        }
    }

    private fun keepReadAccess(uri: Uri) {
        try {
            activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Providers that grant no persistable access still work for this session.
        }
    }

    private fun picked(uri: Uri): JSObject {
        var name = uri.lastPathSegment ?: ""
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0)?.let { n -> name = n }
        }
        val ret = JSObject()
        ret.put("path", uri.toString())
        ret.put("name", name)
        return ret
    }
}
