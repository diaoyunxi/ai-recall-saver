"""
AI撤回保存器 - ZIP 打包脚本

生成可直接用「加载已解压的扩展程序」安装的 ZIP 包。
仅包含扩展运行所需文件，排除开发脚本、私钥、构建产物。

用法：
    python scripts/pack_zip.py

输出：dist/ai-recall-saver-v<版本>.zip
"""
import os
import sys
import json
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_DIR = os.path.join(ROOT, "dist")

# 打包时排除的目录与文件（开发用途，非运行所需）
EXCLUDE_DIRS = {".git", "node_modules", "dist", "scripts", "__pycache__"}
EXCLUDE_FILES = {".gitignore", ".DS_Store"}


def collect_files(root):
    """收集扩展运行所需文件，返回 [(相对路径, 绝对路径)]"""
    result = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn in EXCLUDE_FILES:
                continue
            if fn.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            result.append((rel, full))
    return result


def main():
    manifest_path = os.path.join(ROOT, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest["version"]
    name = manifest["name"]

    os.makedirs(DIST_DIR, exist_ok=True)

    files = collect_files(ROOT)
    print(f"打包文件数：{len(files)}")

    safe_name = "ai-recall-saver"
    zip_path = os.path.join(DIST_DIR, f"{safe_name}-v{version}.zip")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in files:
            zf.write(full, rel)

    # 校验
    with zipfile.ZipFile(zip_path, "r") as zf:
        bad = zf.testzip()
        names = zf.namelist()
        has_manifest = "manifest.json" in names

    print("=" * 50)
    print(f"扩展名称 : {name}")
    print(f"版本     : v{version}")
    print(f"ZIP 文件 : {zip_path} ({os.path.getsize(zip_path)} 字节)")
    print(f"完整性   : {'OK' if bad is None else '损坏 ' + bad}")
    print(f"manifest : {'存在' if has_manifest else '缺失'}")
    print(f"文件列表 : {len(names)} 个")
    print("=" * 50)
    if bad is not None or not has_manifest:
        print("❌ 打包校验失败", file=sys.stderr)
        sys.exit(1)
    print("✅ 打包完成，解压后用「加载已解压的扩展程序」安装即可")


if __name__ == "__main__":
    main()
