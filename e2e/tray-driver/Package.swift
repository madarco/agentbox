// swift-tools-version:5.9
// Standalone: not part of the pnpm workspace. Build with `swift build -c release`.
import PackageDescription

let package = Package(
    name: "tray-driver",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "tray-driver", path: "Sources/tray-driver")
    ]
)
