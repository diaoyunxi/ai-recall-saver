"""
AI撤回保存器 - CRX3 打包脚本

生成符合 Chromium CRX3 格式的 .crx 扩展包。
- 自动生成或复用 RSA 私钥（保存到 scripts/crx_key.pem），保证扩展 ID 跨版本稳定。
- 输出：dist/ai-recall-saver-v<版本>.crx 与 dist/ai-recall-saver-v<版本>.zip

用法：
    python scripts/pack_crx.py

依赖：cryptography
"""
import os
import sys
import json
import struct
import zipfile
import hashlib
import io

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
except ImportError:
    print("缺少依赖：cryptography，请执行 pip install cryptography")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(ROOT, "scripts", "crx_key.pem")
DIST_DIR = os.path.join(ROOT, "dist")


# ---------- protobuf 编码 ----------
def encode_varint(value):
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value & 0x7F)
    return bytes(out)


def encode_field(field_number, wire_type, data):
    tag = encode_varint((field_number << 3) | wire_type)
    if wire_type == 2:  # length-delimited
        return tag + encode_varint(len(data)) + data
    raise ValueError("仅支持 wire_type=2")


# ---------- 收集扩展文件 ----------
def collect_files(root):
    """返回相对路径 -> 绝对路径 的列表，排除不需要打包的文件"""
    exclude_dirs = {".git", "node_modules", "dist", "scripts", "__pycache__"}
    exclude_files = {".gitignore", ".DS_Store"}
    result = []
    for dirpath, dirnames, filenames in os.walk(root):
        # 原地修改 dirnames 以跳过排除目录
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        for fn in filenames:
            if fn in exclude_files:
                continue
            if fn.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            # 对 zip 路径使用正斜杠
            rel = rel.replace(os.sep, "/")
            result.append((rel, full))
    return result


# ---------- 生成 zip ----------
def make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in files:
            zf.write(full, rel)
    return buf.getvalue()


# ---------- 加载/生成私钥 ----------
def load_or_create_key():
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH, "rb") as f:
            pem = f.read()
        return serialization.load_pem_private_key(pem, password=None)
    key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    )
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    with open(KEY_PATH, "wb") as f:
        f.write(pem)
    os.chmod(KEY_PATH, 0o600)
    print(f"已生成新私钥：{KEY_PATH}")
    return key


# ---------- 扩展 ID（crx_id）计算 ----------
# crx_id = SHA256(public_key_der)[0:16]，每个字节取低 4 位映射到 'a'..'p'
def compute_crx_id(public_key_der):
    digest = hashlib.sha256(public_key_der).digest()
    chars = []
    for b in digest[:16]:
        chars.append(chr(ord("a") + (b & 0x0F)))
    return "".join(chars)


# 向后兼容的别名
def extension_id(public_key_der):
    return compute_crx_id(public_key_der)


# ---------- 构造 CRX3 ----------
# 严格遵循 Chromium CRX3 格式（参考 chromium src/components/crx_file/crx_file.cc）：
#
#   message SignedData {
#     string crx_id = 1;            // 从公钥派生的 16 位 ID（a-p）
#   }
#   message AsymmetricKeyProof {
#     bytes public_key = 1;         // SubjectPublicKeyInfo DER
#     bytes signature = 2;          // RSA-PKCS1v15-SHA256
#   }
#   message CrxFileHeader {
#     repeated AsymmetricKeyProof sha256_with_rsa = 2;
#     repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
#     bytes signed_header_data = 10000;   // 序列化后的 SignedData
#   }
#
# 签名输入 = signed_header_data_bytes || zip_archive   （两者拼接）
# 即：signature = RSA-Sign(SHA256(signed_header_data || zip))
#
# 之前版本遗漏了 signed_header_data 字段且签名仅覆盖 zip，导致 Chrome
# 校验器判定「证明缺失」。此版本补全该字段并修正签名范围。
def build_crx3(zip_bytes, private_key):
    public_key = private_key.public_key()
    public_key_der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    # 1) 构造 signed_header_data：序列化 SignedData { string crx_id = 1; }
    crx_id = compute_crx_id(public_key_der)
    signed_data_msg = encode_field(1, 2, crx_id.encode("ascii"))  # SignedData 的字节
    # signed_header_data 字段存的就是 SignedData 序列化后的原始字节
    signed_header_data = signed_data_msg

    # 2) 计算签名：输入 = signed_header_data || zip_bytes
    signed_input = signed_header_data + zip_bytes
    signature = private_key.sign(signed_input, padding.PKCS1v15(), hashes.SHA256())

    # 3) AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
    proof = encode_field(1, 2, public_key_der) + encode_field(2, 2, signature)

    # 4) CrxFileHeader { ... sha256_with_rsa = 2; ... signed_header_data = 10000; }
    header = encode_field(2, 2, proof) + encode_field(10000, 2, signed_header_data)

    crx = b"Cr24" + struct.pack("<I", 3) + struct.pack("<I", len(header)) + header + zip_bytes
    return crx, public_key_der, crx_id


def main():
    # 读取版本
    manifest_path = os.path.join(ROOT, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest["version"]
    name = manifest["name"]

    os.makedirs(DIST_DIR, exist_ok=True)

    files = collect_files(ROOT)
    print(f"打包文件数：{len(files)}")
    zip_bytes = make_zip(files)

    private_key = load_or_create_key()
    crx_bytes, public_key_der, crx_id = build_crx3(zip_bytes, private_key)
    ext_id = crx_id

    safe_name = "ai-recall-saver"
    zip_path = os.path.join(DIST_DIR, f"{safe_name}-v{version}.zip")
    crx_path = os.path.join(DIST_DIR, f"{safe_name}-v{version}.crx")

    with open(zip_path, "wb") as f:
        f.write(zip_bytes)
    with open(crx_path, "wb") as f:
        f.write(crx_bytes)

    print("=" * 50)
    print(f"扩展名称 : {name}")
    print(f"版本     : v{version}")
    print(f"扩展 ID  : {ext_id}")
    print(f"CRX 文件 : {crx_path} ({len(crx_bytes)} 字节)")
    print(f"ZIP 文件 : {zip_path} ({len(zip_bytes)} 字节)")
    print("=" * 50)


if __name__ == "__main__":
    main()
