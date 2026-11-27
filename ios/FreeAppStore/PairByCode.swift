import AVFoundation
import SwiftUI
import UIKit

/// Scan a code / Type the code (#845): pairs with the code the console's or the desktop app's **Add a phone** shows,
/// without the browser. A scanned code is confirmed in ContentView's alert; a typed one in its own. Codes stay in memory.
struct PairByCode: View {
    @ObservedObject var model: CompanionModel
    @State private var scanning = false
    @State private var typing = false
    @State private var typed = ""
    @State private var scanned: String?

    static let question = "Connect this phone to the account that showed this code?"

    var body: some View {
        HStack(spacing: 16) {
            Button("Scan a code") { scanning = true }
            Button("Type the code") { typed = ""; typing = true }
        }
        .disabled(model.busy)
        // Asked once the sheet is gone: an alert raised while it is still closing would not show.
        .sheet(isPresented: $scanning, onDismiss: {
            if let code = scanned { scanned = nil; model.offer(pairCode: code) }
        }) {
            ScanCodeSheet { code in scanned = code; scanning = false }
        }
        .alert("Type the code", isPresented: $typing) {
            TextField("ABCD-EFGH-JKMN-PQRS", text: $typed)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Connect") { model.connect(code: typed); typed = "" }
            Button("Cancel", role: .cancel) { typed = "" }
        } message: {
            Text("Shown under Add a phone in the console or the desktop app. \(Self.question)")
        }
    }
}

/// The camera, looking for a FreeAppStore QR code. Anything else is reported and scanning goes on.
struct ScanCodeSheet: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var problem = ""
    @State private var notOurs = false

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                if problem.isEmpty {
                    QRScanner(found: { text in
                        if let code = URL(string: text).flatMap(CompanionModel.pairCode) { found(code) } else { notOurs = true }
                    }, failed: { problem = $0 })
                    .ignoresSafeArea(edges: .bottom)
                    Text(notOurs ? "That is not a FreeAppStore code." : "Point the camera at the code under Add a phone.")
                        .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(24)
                } else {
                    Text(problem).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .navigationTitle("Scan a code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

/// `AVCaptureMetadataOutput` for `.qr`, on the phone only (no remote service). Reports each new value once.
private struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    let failed: (String) -> Void

    func makeUIViewController(context: Context) -> Controller { Controller(found: found, failed: failed) }
    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        private let found: (String) -> Void
        private let failed: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "online.freeappstore.companion.scanner")
        private var last: String?

        init(found: @escaping (String) -> Void, failed: @escaping (String) -> Void) {
            self.found = found; self.failed = failed
            super.init(nibName: nil, bundle: nil)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: configure()
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async { granted ? self.configure() : self.denied() }
                }
            default: denied()
            }
        }

        private func denied() { failed("Camera access is off. Allow it in Settings > FreeAppStore, or type the code instead.") }

        private func configure() {
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { failed("No camera is available. Type the code instead."); return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { failed("The camera could not start. Type the code instead."); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
            queue.async { [session] in session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            view.layer.sublayers?.forEach { $0.frame = view.bounds }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            queue.async { [session] in session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, text != last else { return }
            last = text
            found(text)
        }
    }
}
