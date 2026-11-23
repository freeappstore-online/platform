import SwiftUI

/// The Store tab: featured, your companion apps, category rows, all apps and search, from the public catalogue.
/// Browse only: Open hands the app's URL to the browser, after the one-time Add to Home Screen guide.
struct StorefrontView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var catalogue: CatalogueStore
    var guide = InstallGuide()
    @Environment(\.openURL) private var openURL
    @State private var query = ""
    @State private var guideFor: CatalogueApp?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if catalogue.apps.isEmpty { empty }
                    else if !query.trimmingCharacters(in: .whitespaces).isEmpty { results }
                    else { browse }
                }
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Store")
            .searchable(text: $query, prompt: "Search apps")
            .refreshable { await catalogue.refresh() }
            .navigationDestination(for: String.self) { id in
                if let app = catalogue.apps.first(where: { $0.id == id }) { AppDetailView(app: app, model: model, open: openApp) }
            }
        }
        .sheet(item: $guideFor) { app in
            InstallGuideSheet(app: app, guide: guide) { openURL(app.appUrl) }
        }
    }

    /// Every Open goes through here: the guide the first time for each app, then straight to the browser.
    private func openApp(_ app: CatalogueApp) {
        if guide.shouldShow(app.id) { guideFor = app } else { openURL(app.appUrl) }
    }

    @ViewBuilder private var empty: some View {
        VStack(spacing: 12) {
            if catalogue.loading {
                ProgressView()
            } else {
                Text("Connect to the internet to load the store").font(.headline).multilineTextAlignment(.center)
                Button("Retry") { Task { await catalogue.refresh() } }.buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }

    @ViewBuilder private var browse: some View {
        if catalogue.stale {
            Text("Showing the last copy of the store saved on this phone.").font(.footnote).foregroundStyle(.secondary).padding(.horizontal)
        }
        featured
        let yours = catalogue.apps.filter { app in model.apps.contains { $0.id == app.id && model.enabled($0) } }
        if model.signedIn && !yours.isEmpty { row("Yours", yours) }
        ForEach(Catalogue.categories(catalogue.apps), id: \.name) { category in row(category.name, category.apps) }
        Text("All apps").font(.title2.bold()).padding(.horizontal)
        list(Catalogue.sortedByName(catalogue.apps))
    }

    @ViewBuilder private var results: some View {
        let found = Catalogue.search(catalogue.apps, query)
        if found.isEmpty {
            Text("No apps match “\(query)”").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 40)
        } else {
            list(Catalogue.sortedByName(found))
        }
    }

    private var featured: some View {
        TabView {
            ForEach(Catalogue.featured(catalogue.apps)) { app in
                NavigationLink(value: app.id) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(app.icon).font(.system(size: 64))
                        Text(app.name).font(.title2.bold())
                        Text(app.description).font(.subheadline).lineLimit(2)
                    }
                    .foregroundStyle(.white)
                    .padding(20)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .background(Color(hex: app.iconBg).gradient, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .padding(.horizontal)
                    .padding(.bottom, 48) // room for the page dots below the card
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
            }
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .frame(height: 288)
    }

    private func row(_ title: String, _ apps: [CatalogueApp]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title3.bold()).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(apps) { app in
                        NavigationLink(value: app.id) {
                            VStack(alignment: .leading, spacing: 6) {
                                AppIconView(app: app, size: 64)
                                Text(app.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(app.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .frame(width: 110, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    private func list(_ apps: [CatalogueApp]) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(apps) { app in
                HStack(spacing: 12) {
                    NavigationLink(value: app.id) {
                        HStack(spacing: 12) {
                            AppIconView(app: app, size: 48)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(app.name).font(.body.weight(.semibold)).lineLimit(1)
                                Text(app.category).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    Button("Open") { openApp(app) }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule)
                        .accessibilityLabel("Open \(app.name)")
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                Divider().padding(.leading, 76)
            }
        }
    }
}

/// The app's emoji on its `iconBg`, as on the storefront.
struct AppIconView: View {
    let app: CatalogueApp
    let size: CGFloat

    var body: some View {
        Text(app.icon)
            .font(.system(size: size * 0.55))
            .frame(width: size, height: size)
            .background(Color(hex: app.iconBg), in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
            .accessibilityHidden(true)
    }
}

extension Color {
    /// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, already validated by CatalogueApp.
    init(hex: String) {
        var digits = String(hex.dropFirst())
        if digits.count <= 4 { digits = digits.map { "\($0)\($0)" }.joined() }
        let value = UInt64(digits, radix: 16) ?? 0
        let hasAlpha = digits.count == 8
        let rgb = hasAlpha ? value >> 8 : value
        self.init(.sRGB, red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255,
                  blue: Double(rgb & 0xff) / 255, opacity: hasAlpha ? Double(value & 0xff) / 255 : 1)
    }
}
