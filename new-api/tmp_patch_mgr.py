import pathlib
p = pathlib.Path(r"relay\channel\antigravity\adaptor.go")
content = p.read_text(encoding="utf-8")

old = """func shouldUseManagerPassthrough(info *relaycommon.RelayInfo) bool {
	if antigravityManagerBaseURL() == "" {
		return false
	}
	if info != nil && (info.RelayMode == relayconstant.RelayModeImagesGenerations || info.RelayMode == relayconstant.RelayModeImagesEdits) {
		return false
	}
	return true
}"""

new = """func shouldUseManagerPassthrough(info *relaycommon.RelayInfo) bool {
	if antigravityManagerBaseURL() == "" {
		return false
	}
	return true
}"""

if old in content:
    content = content.replace(old, new)
    p.write_text(content, encoding="utf-8")
    print("patched shouldUseManagerPassthrough")
else:
    print("ERROR: target block not found!")
    # Show what we have
    idx = content.find("func shouldUseManagerPassthrough")
    if idx >= 0:
        print("found at index", idx)
        print(content[idx:idx+300])
