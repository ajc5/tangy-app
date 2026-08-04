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

    private func cacheFileURL(for urlString: String) -> URL {
        let fileName = urlString.data(using: .utf8)?.base64EncodedString() ?? UUID().uuidString
        return cacheDir!.appendingPathComponent(fileName)
    }

    private func cacheMetaURL(for urlString: String) -> URL {
        let fileName = urlString.data(using: .utf8)?.base64EncodedString() ?? UUID().uuidString
        return cacheDir!.appendingPathComponent("\(fileName).meta.json")
    }

    private func resolveFetch(_ call: CAPPluginCall, status: Int, body: String, contentType: String) {
        let result: [String: Any] = [
            "ok": (200..<300).contains(status),
            "status": status,
            "body": body,
            "contentType": contentType
        ]
        DispatchQueue.main.async {
            call.resolve(result)
        }
    }

    /**
     * Native HTTP via URLSession — no CORS. GET responses are cached to disk
     * and served offline; non-GET requests (login POST, submissions) always
     * hit the network and are never cached.
     */
    @objc func fetch(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url is required")
            return
        }
        let method = (call.getString("method", "GET") ?? "GET").uppercased()
        let body = call.getString("body")
        let headers = call.getObject("headers")?.reduce(into: [String: String]()) { result, pair in
            result[pair.key] = pair.value as? String
        } ?? [:]

        let fileURL = cacheFileURL(for: urlString)
        let metaURL = cacheMetaURL(for: urlString)
        let fileManager = FileManager.default

        // GET: serve from disk cache when present (offline support)
        if method == "GET" && fileManager.fileExists(atPath: fileURL.path) {
            if let cachedBody = try? String(contentsOf: fileURL, encoding: .utf8) {
                var mimeType = "application/octet-stream"
                if let metaData = try? Data(contentsOf: metaURL),
                   let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any],
                   let storedMime = meta["mimeType"] as? String {
                    mimeType = storedMime
                }
                resolveFetch(call, status: 200, body: cachedBody, contentType: mimeType)
                return
            }
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        if let body = body, method != "GET" && method != "HEAD" {
            request.httpBody = body.data(using: .utf8)
        }

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                // Offline fallback: serve from cache for GET requests
                if method == "GET", fileManager.fileExists(atPath: fileURL.path),
                   let cachedBody = try? String(contentsOf: fileURL, encoding: .utf8) {
                    self.resolveFetch(call, status: 200, body: cachedBody, contentType: "application/octet-stream")
                } else {
                    call.reject("Fetch failed: \(error.localizedDescription)")
                }
                return
            }

            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let contentType = (response as? HTTPURLResponse)?.allHeaderFields["Content-Type"] as? String
                ?? "application/octet-stream"
            let bodyString = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""

            // Cache successful GET responses for offline use
            if method == "GET", (200..<300).contains(status) {
                try? bodyString.write(to: fileURL, atomically: true, encoding: .utf8)
                let meta: [String: Any] = ["mimeType": contentType]
                if let metaData = try? JSONSerialization.data(withJSONObject: meta) {
                    try? metaData.write(to: metaURL)
                }
            }

            self.resolveFetch(call, status: status, body: bodyString, contentType: contentType)
        }
        task.resume()
    }

    @objc func setDistributedCachingEnabled(_ call: CAPPluginCall) {
        // Not available on iOS yet
        call.resolve()
    }
}
