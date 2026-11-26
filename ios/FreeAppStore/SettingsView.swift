import CoreLocation
import SwiftUI
import UIKit

/// Profile, permissions, history and About. Sign out revokes this phone's device credential.
struct SettingsView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @Environment(\.openURL) private var openURL
    @State private var disconnectPrompt = false
    @State private var clearHistoryPrompt = false

    /// The console's account deletion flow (#653): app stores require deletion to start from inside the app.
    static let deleteAccountLink = "https://freeappstore.online/app/settings?delete-account=1"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    if model.expired { ExpiredCard(model: model) }
                    if model.signedIn || model.expired { account }
                    about
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Settings")
        }
        .alert("Sign out of this phone?", isPresented: $disconnectPrompt) {
            Button("Sign out", role: .destructive) { model.disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stops location sharing and deletes this phone’s pending updates, its sharing history and platform location copies. Saved runs in your apps are separate. An internet connection is needed to finish.")
        }
        .alert("Clear sharing history?", isPresented: $clearHistoryPrompt) {
            Button("Clear history", role: .destructive) { model.clearHistory() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deletes the sharing map and timeline kept on this phone. Updates waiting to sync still upload.")
        }
    }

    @ViewBuilder private var account: some View {
        if let profile = model.profile { ProfileSection(profile: profile, open: open) } else { Text(model.name).font(.headline) }
        if let days = model.expiresInDays {
            VStack(alignment: .leading, spacing: 4) {
                Text("Connection renews when you reconnect — expires in \(days) day\(days == 1 ? "" : "s")").font(.footnote).foregroundStyle(.secondary)
                Button("Reconnect") { model.reconnect() }.font(.footnote).disabled(model.busy)
            }
        }
        GroupBox("Location permission") {
            VStack(alignment: .leading, spacing: 8) {
                PermissionControls(collector: collector)
                if collector.permitted { Text("Precise location is on.").font(.footnote) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("Manage account") { open("https://freeappstore.online/app/") }
        Button("Delete account") { open(Self.deleteAccountLink) }
        Button("Clear sharing history") { clearHistoryPrompt = true }
        Button("Sign out") { disconnectPrompt = true }.disabled(model.busy)
    }

    @ViewBuilder private var about: some View {
        Text("About").font(.title3.bold())
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Version", value: AppInfo.current.version)
                LabeledContent("Build", value: AppInfo.current.build)
                LabeledContent("Commit", value: AppInfo.current.commit)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("What's new") { open(AppInfo.current.notesLink) }
        Button("How your data is used") { open("https://docs.freeappstore.online/native-companion/") }
        Button("Privacy policy") { open("https://freeappstore.online/privacy") }
    }

    private func open(_ link: String) { if let url = URL(string: link) { openURL(url) } }
}

/// The location permission explanation and the buttons that fix it, for whichever state applies.
struct PermissionControls: View {
    @ObservedObject var collector: LocationCollector
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch collector.authorization {
        case .notDetermined:
            Text("FreeAppStore records your route for the apps you enable, including while your phone is locked. Choose Allow While Using App with Precise Location on.").font(.footnote)
            Button("Set up location") { collector.requestWhenInUse() }
        case .denied, .restricted:
            Text("Location access is off for FreeAppStore.").font(.footnote)
            Button("Open Settings") { openSettings() }
        default:
            if !collector.fullAccuracy {
                Text("Turn on Precise Location in Settings. Approximate location is never used to record routes.").font(.footnote)
                Button("Use precise location") { collector.requestFullAccuracy() }
                Button("Open Settings") { openSettings() }
            } else if collector.authorization == .authorizedWhenInUse {
                Button("Keep recording after restarts") { collector.requestAlways() }
            }
        }
    }

    private func openSettings() { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
}

/// The account's picture, its initial until (or unless) it loads.
struct Avatar: View {
    let profile: Profile
    let size: CGFloat

    var body: some View {
        AsyncImage(url: profile.avatarUrl) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Circle().fill(Color.accentColor.opacity(0.2)).overlay { Text(profile.name.prefix(1).uppercased()).foregroundStyle(Color.accentColor) }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// Avatar and name, for the Store's toolbar.
struct ProfileSummary: View {
    let profile: Profile

    var body: some View {
        HStack(spacing: 6) {
            Avatar(profile: profile, size: 28)
            Text(profile.name).font(.subheadline).lineLimit(1)
        }
    }
}

/// The signed-in account in full, and this phone's connection (#829).
struct ProfileSection: View {
    let profile: Profile
    let open: (String) -> Void

    var body: some View {
        HStack(spacing: 16) {
            Avatar(profile: profile, size: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).font(.title2.bold())
                Text(profile.account).foregroundStyle(.secondary)
            }
        }
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Signed in with", value: profile.providerName)
                LabeledContent("User ID", value: profile.id)
                if let email = profile.email { LabeledContent("Email", value: email) }
                LabeledContent("Roles", value: profile.roles.joined(separator: ", "))
                if profile.creator {
                    LabeledContent("Your apps", value: "\(profile.appCount)")
                    Button("Open the console") { open(Profile.consoleLink) }
                }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("This phone", value: profile.deviceLabel)
                if profile.pairedAt > 0 { LabeledContent("Connected", value: Self.date(profile.pairedAt)) }
                if profile.expiresAt > 0 { LabeledContent("Connection expires", value: Self.date(profile.expiresAt)) }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private static func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .omitted)
    }
}
