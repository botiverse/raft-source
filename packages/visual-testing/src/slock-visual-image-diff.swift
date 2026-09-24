#!/usr/bin/env swift
import AppKit
import Foundation

struct Metrics: Codable {
    let baselineWidth: Int
    let baselineHeight: Int
    let currentWidth: Int
    let currentHeight: Int
    let comparisonWidth: Int
    let comparisonHeight: Int
    let rgbSimilarity: Double
    let pixelPerfectSimilarity: Double
    let pixelMismatchRatio: Double
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count == 9 else {
    fail("Usage: slock-visual-image-diff.swift <baseline.png> <current.png> <side-by-side.png> <metrics.json> <case-id> <case-title> <baseline-label> <current-label>")
}

let baselineURL = URL(fileURLWithPath: CommandLine.arguments[1])
let currentURL = URL(fileURLWithPath: CommandLine.arguments[2])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[3])
let metricsURL = URL(fileURLWithPath: CommandLine.arguments[4])
let caseId = CommandLine.arguments[5]
let caseTitle = CommandLine.arguments[6]
let baselineLabel = CommandLine.arguments[7].uppercased()
let currentLabel = CommandLine.arguments[8].uppercased()

func loadImage(_ url: URL) -> NSBitmapImageRep {
    guard let image = NSImage(contentsOf: url),
          let tiff = image.tiffRepresentation,
          let source = NSBitmapImageRep(data: tiff) else {
        fail("Unable to load image: \(url.path)")
    }
    let width = source.pixelsWide
    let height = source.pixelsHigh
    guard let target = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4,
        bitsPerPixel: 32
    ) else {
        fail("Unable to allocate image buffer: \(url.path)")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: target)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    return target
}

func resized(_ image: NSBitmapImageRep, width: Int, height: Int) -> NSBitmapImageRep {
    guard let target = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4,
        bitsPerPixel: 32
    ) else {
        fail("Unable to allocate resized image buffer")
    }
    let sourceImage = NSImage(size: NSSize(width: image.pixelsWide, height: image.pixelsHigh))
    sourceImage.addRepresentation(image)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: target)
    NSGraphicsContext.current?.imageInterpolation = .high
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    sourceImage.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    return target
}

func rgba(_ image: NSBitmapImageRep, x: Int, y: Int) -> (Int, Int, Int, Int) {
    let color = image.colorAt(x: x, y: y) ?? .white
    let rgb = color.usingColorSpace(.deviceRGB) ?? .white
    return (
        Int((rgb.redComponent * 255).rounded()),
        Int((rgb.greenComponent * 255).rounded()),
        Int((rgb.blueComponent * 255).rounded()),
        Int((rgb.alphaComponent * 255).rounded())
    )
}

func rgbSimilarity(_ baseline: NSBitmapImageRep, _ current: NSBitmapImageRep) -> Double {
    let width = max(baseline.pixelsWide, current.pixelsWide)
    let height = max(baseline.pixelsHigh, current.pixelsHigh)
    let left = resized(baseline, width: width, height: height)
    let right = resized(current, width: width, height: height)
    var diff = 0.0
    for y in 0..<height {
        for x in 0..<width {
            let a = rgba(left, x: x, y: y)
            let b = rgba(right, x: x, y: y)
            diff += Double(abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2)) / 3.0
        }
    }
    let maxDiff = Double(width * height) * 255.0
    return max(0.0, 1.0 - diff / maxDiff)
}

func pixelPerfectSimilarity(_ baseline: NSBitmapImageRep, _ current: NSBitmapImageRep) -> Double {
    let width = max(baseline.pixelsWide, current.pixelsWide)
    let height = max(baseline.pixelsHigh, current.pixelsHigh)
    var matching = 0
    for y in 0..<height {
        for x in 0..<width {
            let a = x < baseline.pixelsWide && y < baseline.pixelsHigh ? rgba(baseline, x: x, y: y) : (255, 255, 255, 255)
            let b = x < current.pixelsWide && y < current.pixelsHigh ? rgba(current, x: x, y: y) : (255, 255, 255, 255)
            if a.0 == b.0 && a.1 == b.1 && a.2 == b.2 && a.3 == b.3 {
                matching += 1
            }
        }
    }
    return Double(matching) / Double(width * height)
}

func drawSideBySide(
    baseline: NSBitmapImageRep,
    current: NSBitmapImageRep,
    outputURL: URL,
    metrics: Metrics
) {
    let gutter = 24
    let padding = 18
    let metricsHeight = 76
    let framePadding = 16
    let headerHeight = 50
    let shadow = 4
    let baselinePanel = panelSize(for: baseline, framePadding: framePadding, headerHeight: headerHeight, shadow: shadow)
    let currentPanel = panelSize(for: current, framePadding: framePadding, headerHeight: headerHeight, shadow: shadow)
    let width = padding * 2 + baselinePanel.width + gutter + currentPanel.width
    let panelHeight = max(baselinePanel.height, currentPanel.height)
    let height = padding * 2 + panelHeight + metricsHeight
    guard let target = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4,
        bitsPerPixel: 32
    ) else {
        fail("Unable to allocate side-by-side image")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: target)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    let panelTop = height - padding
    drawPanel(
        image: baseline,
        x: padding,
        top: panelTop,
        framePadding: framePadding,
        headerHeight: headerHeight,
        shadow: shadow,
        provider: baselineLabel,
        rawSize: "\(metrics.baselineWidth)×\(metrics.baselineHeight)"
    )
    drawPanel(
        image: current,
        x: padding + baselinePanel.width + gutter,
        top: panelTop,
        framePadding: framePadding,
        headerHeight: headerHeight,
        shadow: shadow,
        provider: currentLabel,
        rawSize: "\(metrics.currentWidth)×\(metrics.currentHeight)"
    )

    let text = String(
        format: "RGB similarity %.1f%%   Pixel perfect %.2f%%   Mismatch %.2f%%",
        metrics.rgbSimilarity * 100,
        metrics.pixelPerfectSimilarity * 100,
        metrics.pixelMismatchRatio * 100
    )
    let sizeText = "Compare canvas \(metrics.comparisonWidth)×\(metrics.comparisonHeight)"
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 14, weight: .bold),
        .foregroundColor: NSColor.black,
        .paragraphStyle: paragraph
    ]
    let sizeAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
        .foregroundColor: NSColor(calibratedWhite: 0.35, alpha: 1),
        .paragraphStyle: paragraph
    ]
    text.draw(in: NSRect(x: padding, y: 34, width: width - padding * 2, height: 20), withAttributes: attrs)
    sizeText.draw(in: NSRect(x: padding, y: 16, width: width - padding * 2, height: 18), withAttributes: sizeAttrs)
    NSGraphicsContext.restoreGraphicsState()

    guard let data = target.representation(using: .png, properties: [:]) else {
        fail("Unable to encode side-by-side image")
    }
    try! FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! data.write(to: outputURL)
}

func panelSize(
    for image: NSBitmapImageRep,
    framePadding: Int,
    headerHeight: Int,
    shadow: Int
) -> (width: Int, height: Int) {
    (
        image.pixelsWide + framePadding * 2 + shadow,
        image.pixelsHigh + framePadding * 2 + headerHeight + shadow
    )
}

func drawPanel(
    image: NSBitmapImageRep,
    x: Int,
    top: Int,
    framePadding: Int,
    headerHeight: Int,
    shadow: Int,
    provider: String,
    rawSize: String
) {
    let size = panelSize(for: image, framePadding: framePadding, headerHeight: headerHeight, shadow: shadow)
    let frameX = x
    let frameY = top - size.height + shadow
    let frameWidth = size.width - shadow
    let frameHeight = size.height - shadow
    let shadowRect = NSRect(x: frameX + shadow, y: frameY - shadow, width: frameWidth, height: frameHeight)
    let frameRect = NSRect(x: frameX, y: frameY, width: frameWidth, height: frameHeight)
    NSColor.black.setFill()
    shadowRect.fill()
    NSColor.white.setFill()
    frameRect.fill()
    NSColor.black.setStroke()
    let border = NSBezierPath(rect: frameRect)
    border.lineWidth = 2
    border.stroke()

    drawHeader(
        x: frameX + framePadding,
        y: frameY + frameHeight - framePadding - headerHeight,
        width: frameWidth - framePadding * 2,
        provider: provider,
        rawSize: rawSize
    )

    let imageObject = NSImage(size: NSSize(width: image.pixelsWide, height: image.pixelsHigh))
    imageObject.addRepresentation(image)
    imageObject.draw(
        in: NSRect(
            x: frameX + framePadding,
            y: frameY + framePadding,
            width: image.pixelsWide,
            height: image.pixelsHigh
        )
    )
}

func drawHeader(
    x: Int,
    y: Int,
    width: Int,
    provider: String,
    rawSize: String
) {
    let idAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .bold),
        .foregroundColor: NSColor(calibratedWhite: 0.45, alpha: 1)
    ]
    let titleAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 18, weight: .bold),
        .foregroundColor: NSColor.black
    ]
    caseId.uppercased().draw(in: NSRect(x: x, y: y + 27, width: width - 80, height: 14), withAttributes: idAttrs)
    caseTitle.draw(in: NSRect(x: x, y: y + 4, width: width - 80, height: 24), withAttributes: titleAttrs)

    let sizeAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
        .foregroundColor: NSColor(calibratedWhite: 0.35, alpha: 1)
    ]
    rawSize.draw(in: NSRect(x: x, y: y, width: width - 80, height: 14), withAttributes: sizeAttrs)

    let badgeWidth = max(58, provider.count * 8 + 16)
    let badgeRect = NSRect(x: x + width - badgeWidth, y: y + 20, width: badgeWidth, height: 22)
    NSColor(calibratedRed: 1.0, green: 0.83, blue: 0.25, alpha: 1).setFill()
    badgeRect.fill()
    NSColor.black.setStroke()
    let badgeBorder = NSBezierPath(rect: badgeRect)
    badgeBorder.lineWidth = 2
    badgeBorder.stroke()
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let badgeAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
        .foregroundColor: NSColor.black,
        .paragraphStyle: paragraph
    ]
    provider.draw(in: NSRect(x: Int(badgeRect.minX), y: Int(badgeRect.minY) + 4, width: badgeWidth, height: 16), withAttributes: badgeAttrs)
}

let baseline = loadImage(baselineURL)
let current = loadImage(currentURL)
let rgb = rgbSimilarity(baseline, current)
let pixel = pixelPerfectSimilarity(baseline, current)
let comparisonWidth = max(baseline.pixelsWide, current.pixelsWide)
let comparisonHeight = max(baseline.pixelsHigh, current.pixelsHigh)
let metrics = Metrics(
    baselineWidth: baseline.pixelsWide,
    baselineHeight: baseline.pixelsHigh,
    currentWidth: current.pixelsWide,
    currentHeight: current.pixelsHigh,
    comparisonWidth: comparisonWidth,
    comparisonHeight: comparisonHeight,
    rgbSimilarity: rgb,
    pixelPerfectSimilarity: pixel,
    pixelMismatchRatio: 1.0 - pixel
)
drawSideBySide(baseline: baseline, current: current, outputURL: outputURL, metrics: metrics)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
try! FileManager.default.createDirectory(at: metricsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try! encoder.encode(metrics).write(to: metricsURL)
