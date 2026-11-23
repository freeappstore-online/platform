import SwiftUI

/// iOS has no API to add a web app to the Home Screen, so the first Open of each app shows how. Device UI
/// preferences in UserDefaults: they survive `LocalStore.clear()` on disconnect.
struct InstallGuide {
    static let offKey = "installGuide.off"
    static let seenKey = "installGuide.seen"
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func shouldShow(_ appId: String) -> Bool { !defaults.bool(forKey: Self.offKey) && !seen.contains(appId) }
    func markSeen(_ appId: String) { if !seen.contains(appId) { defaults.set(seen + [appId], forKey: Self.seenKey) } }
    /// Open from the guide. "Don't show this again" (for every app) is saved only here, never on Cancel.
    func opened(_ appId: String, dontShowAgain: Bool) {
        markSeen(appId)
        if dontShowAgain { defaults.set(true, forKey: Self.offKey) }
    }

    private var seen: [String] { defaults.stringArray(forKey: Self.seenKey) ?? [] }
}

/// Share → Add to Home Screen, then Open. Cancel saves nothing: the guide shows again next time.
struct InstallGuideSheet: View {
    let app: CatalogueApp
    let guide: InstallGuide
    let open: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var dontShow = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        AppIconView(app: app, size: 56)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Add \(app.name) to your Home Screen").font(.title3.bold())
                            Text("It opens like an app, full screen, and stays signed in.").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    step(1, "safari", "Open \(app.name) in Safari.")
                    step(2, "square.and.arrow.up", "Tap Share in the toolbar. On newer iOS, it may be under •••.")
                    step(3, "plus.app", "Choose Add to Home Screen, then Add.")
                    Toggle("Don't show this again", isOn: $dontShow)
                    Button {
                        guide.opened(app.id, dontShowAgain: dontShow)
                        dismiss()
                        open()
                    } label: {
                        Text("Open \(app.name)").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .padding(24)
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func step(_ number: Int, _ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.title2).foregroundStyle(.tint).frame(width: 32)
            Text(text)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number). \(text)")
    }
}
