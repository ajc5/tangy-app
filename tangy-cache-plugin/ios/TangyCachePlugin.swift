import Capacitor

@objc(TangyCachePlugin)
public class TangyCachePlugin: CAPPlugin {

    private var cacheDir: URL?

    override public func load() {
        super.load()
        let fileManager = FileManager.default
        let cachesDir = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDir = cachesDir.appendingPathComponent("tangy-libcache", isDirectory: true)
        try? fileManager.createDirectory(at: cacheDir!, withIntermediateDirectories: true)
    }

    @objc func store(_ call: CAPPluginCall) {
        guard let url = call.getString("url"),
              let body = call.getString("body") else {
            call.reject("url and body are required")
            return
        }
        let mimeType = call.getString("mimeType") ?? "application/octet-stream"

        // Store to local file as simple cache
        let fileURL = cacheDir!.appendingPathComponent(url.data(using: .utf8)?.base64EncodedString() ?? UUID().uuidString)
        do {
            try body.write(to: fileURL, atomically: true, encoding: .utf8)
            call.resolve()
        } catch {
            call.reject("Store failed: \(error.localizedDescription)")
        }
    }

    @objc func retrieve(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else {
            call.reject("url is required")
            return
        }

        let fileURL = cacheDir!.appendingPathComponent(url.data(using: .utf8)?.base64EncodedString() ?? "")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            call.resolve([:])
            return
        }

        do {
            let body = try String(contentsOf: fileURL, encoding: .utf8)
            call.resolve([
                "body": body,
                "mimeType": "application/octet-stream",
                "headers": [:]
            ])
        } catch {
            call.reject("Retrieve failed: \(error.localizedDescription)")
        }
    }

    @objc func isCached(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else {
            call.reject("url is required")
            return
        }

        let fileURL = cacheDir!.appendingPathComponent(url.data(using: .utf8)?.base64EncodedString() ?? "")
        call.resolve(["cached": FileManager.default.fileExists(atPath: fileURL.path)])
    }

    @objc func downloadAndRetain(_ call: CAPPluginCall) {
        guard let urlsArray = call.getArray("urls", JSObject.self) else {
            call.reject("urls is required")
            return
        }

        let jobId = UUID().uuidString
        var urlStrings: [String] = []

        for entry in urlsArray {
            if let url = entry["url"] as? String {
                urlStrings.append(url)
                // In a full implementation, download and cache
            }
        }

        call.resolve(["jobId": jobId])
    }

    @objc func release(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func getPinProgress(_ call: CAPPluginCall) {
        call.resolve([
            "progress": [
                "status": "not-pinned",
                "totalSize": 0,
                "transferred": 0
            ]
        ])
    }

    @objc func getStats(_ call: CAPPluginCall) {
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: cacheDir?.path ?? "")) ?? []
        call.resolve([
            "stats": [
                "entryCount": contents.count,
                "totalSizeBytes": 0,
                "sizeLimitBytes": 0
            ]
        ])
    }

    @objc func clear(_ call: CAPPluginCall) {
        if let cacheDir = cacheDir {
            try? FileManager.default.removeItem(at: cacheDir)
            try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        }
        call.resolve()
    }

    @objc func setDistributedCachingEnabled(_ call: CAPPluginCall) {
        // Not available on iOS yet
        call.resolve()
    }
}
