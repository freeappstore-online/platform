import SwiftUI

/// One app's page: icon, description, permissions, Open, and Use with companion for apps on the native list.
struct AppDetailView: View {
    let app: CatalogueApp
    @ObservedObject var model: CompanionModel
    let open: (CatalogueApp) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Color(hex: app.iconBg)
                    .frame(height: 120)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityHidden(true)
                HStack(alignment: .center, spacing: 16) {
                    AppIconView(app: app, size: 96)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(app.name).font(.title2.bold())
                        Text(app.category).font(.subheadline).foregroundStyle(.secondary)
                        if let developer = app.developer { Text(developer).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Button { open(app) } label: { Text("Open").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .accessibilityLabel("Open \(app.name)")
                if !app.description.isEmpty { Text(app.description) }
                if let connected = model.apps.first(where: { $0.id == app.id }) { companion(connected) }
                if model.signedIn {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            ContributeToggle(appId: app.id, name: app.name, model: model)
                            Text("Generate \(app.name)'s published jobs, such as narration, on this phone. Nothing happens if it has none.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let permissions = app.permissions { self.permissions(permissions) }
            }
            .padding(24)
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Never grants directly: on opens the existing disclosure sheet, and only its button enables.
    @ViewBuilder private func companion(_ connected: ConnectedApp) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                if model.signedIn {
                    Toggle("Use with companion", isOn: Binding(
                        get: { model.enabled(connected) },
                        set: { on in if on { model.consent = connected } else { model.disable(connected) } }
                    ))
                    .disabled(model.busy)
                    if model.blocked.contains(connected.id) {
                        Text("Disabled on this phone. Server revocation will finish when connected.").font(.footnote)
                    }
                } else {
                    Button("Sign in to use with FreeAppStore") { model.connect() }.disabled(model.busy)
                }
                Text("Background location: \(connected.purpose)").font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func permissions(_ permissions: [CatalogueApp.Permission]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Permissions").font(.title3.bold())
            if permissions.isEmpty {
                Text("\(app.name) doesn't ask for any permissions: no microphone, camera, location or device access.").font(.subheadline)
            }
            ForEach(permissions, id: \.id) { permission in
                VStack(alignment: .leading, spacing: 2) {
                    Text(CatalogueApp.permissionLabel(permission.id)).font(.subheadline.weight(.semibold))
                    if !permission.reason.isEmpty { Text(permission.reason).font(.footnote).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
