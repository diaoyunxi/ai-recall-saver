"""
AI撤回保存器 - CRX3 独立校验器

不依赖 Chrome，仅依据 Chromium CRX3 规范独立解析并验证一个 .crx 文件，
判定它是否能被 Chrome 正确接受。校验项：

  [1] 文件头：magic == "Cr24"，version == 3，header_size 合法
  [2] CrxFileHeader protobuf 解析：提取 sha256_with_rsa[].{public_key,signature}
      与 signed_header_data（field 10000，含 SignedData.crx_id）
  [3] crx_id 一致性：从 public_key_der 派生的 ID 必须等于 SignedData.crx_id
  [4] 签名有效性：用公钥验证 RSA-PKCS1v15-SHA256(signed_header_data || zip)
  [5] zip 完整性：zip 部分可解压且含 manifest.json

全部通过即证明 CRX3 结构与密码学证明完整有效（等价于 Chrome 可接受）。

用法：
    python scripts/verify_crx.py [path/to/xxx.crx]
    不传路径则校验 dist/ 下最新生成的 crx。
"""
import os
import sys
import struct
import zipfile
import hashlib
import io

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.exceptions import InvalidSignature
except ImportError:
    print("[FAIL] 缺少依赖 cryptography")
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_DIR = os.path.join(ROOT, "dist")


# ---------- 极简 protobuf 解码（length-delimited 字段） ----------
def read_varint(buf, pos):
    """从 pos 处读取 varint，返回 (value, new_pos)"""
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("varint 越界")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
        if shift > 63:
            raise ValueError("varint 过长")
    return result, pos


def parse_length_delimited_message(buf):
    """解析一条 protobuf 消息，返回 {field_number: [bytes,...]}（仅记录 wire_type=2 字段）"""
    fields = {}
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        field_number = tag >> 3
        wire_type = tag & 0x07
        if wire_type == 2:  # length-delimited
            length, pos = read_varint(buf, pos)
            data = buf[pos:pos + length]
            pos += length
            fields.setdefault(field_number, []).append(data)
        elif wire_type == 0:  # varint
            _, pos = read_varint(buf, pos)
        elif wire_type == 1:  # 64-bit
            pos += 8
        elif wire_type == 5:  # 32-bit
            pos += 4
        else:
            raise ValueError(f"不支持的 wire_type={wire_type} (field={field_number})")
    return fields


def compute_crx_id_bytes_from_pubkey(public_key_der):
    """官方规范：crx_id = SHA256(public_key_der)[0:16] 原始 16 字节二进制"""
    return hashlib.sha256(public_key_der).digest()[:16]


def extension_id_string_from_pubkey(public_key_der):
    """显示用 16 字符 a-p 字符串"""
    digest = hashlib.sha256(public_key_der).digest()
    return "".join(chr(ord("a") + (b & 0x0F)) for b in digest[:16])


def verify(crx_path):
    print("=" * 60)
    print(f"校验文件: {crx_path}")
    print("=" * 60)
    with open(crx_path, "rb") as f:
        data = f.read()

    ok = True
    checks = []

    # [1] 文件头
    if len(data) < 12:
        checks.append(("[1] 文件头", False, "文件过短"))
        ok = False
        return finish(checks, ok)
    magic = data[:4]
    version = struct.unpack("<I", data[4:8])[0]
    header_size = struct.unpack("<I", data[8:12])[0]
    c1 = (magic == b"Cr24") and (version == 3) and (12 + header_size <= len(data))
    checks.append(("[1] 文件头 (magic/version/header_size)", c1,
                   f"magic={magic!r} version={version} header_size={header_size}"))
    if not c1:
        ok = False
        return finish(checks, ok)

    header_bytes = data[12:12 + header_size]
    zip_bytes = data[12 + header_size:]

    # [2] 解析 CrxFileHeader
    try:
        header_fields = parse_length_delimited_message(header_bytes)
    except Exception as e:
        checks.append(("[2] CrxFileHeader 解析", False, f"异常: {e}"))
        ok = False
        return finish(checks, ok)

    rsa_proofs = header_fields.get(2, [])  # repeated sha256_with_rsa
    signed_header_data_list = header_fields.get(10000, [])  # bytes signed_header_data

    c2 = (len(rsa_proofs) >= 1) and (len(signed_header_data_list) >= 1)
    checks.append(("[2] CrxFileHeader 含 sha256_with_rsa 与 signed_header_data", c2,
                   f"rsa_proofs={len(rsa_proofs)} signed_header_data={len(signed_header_data_list)}"))
    if not c2:
        ok = False
        checks.append(("[2-注] 缺少 signed_header_data 即 Chrome 报「证明缺失」", True, ""))
        return finish(checks, ok)

    proof_bytes = rsa_proofs[0]
    proof_fields = parse_length_delimited_message(proof_bytes)
    public_key_der = proof_fields.get(1, [b""])[0]
    signature = proof_fields.get(2, [b""])[0]

    signed_header_data = signed_header_data_list[0]

    # [3] crx_id 一致性（官方规范：16 字节原始二进制比较）
    try:
        sd_fields = parse_length_delimited_message(signed_header_data)
        crx_id_signed = sd_fields.get(1, [b""])[0]  # 原始 bytes
    except Exception as e:
        crx_id_signed = None
    crx_id_computed = compute_crx_id_bytes_from_pubkey(public_key_der)
    c3 = crx_id_signed == crx_id_computed
    ext_id_str = extension_id_string_from_pubkey(public_key_der)
    checks.append(("[3] crx_id 一致 (16字节二进制)", c3,
                   f"签名内={crx_id_signed!r} 派生={crx_id_computed!r} 扩展ID={ext_id_str!r}"))
    if not c3:
        ok = False

    # [4] 签名验证（官方规范）：
    #     签名输入 = "CRX3 SignedData\x00" + uint32_le(len(signed_header_data))
    #                + signed_header_data + zip
    signed_input = (
        b"CRX3 SignedData\x00"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_bytes
    )
    try:
        pub = serialization.load_der_public_key(public_key_der)
        pub.verify(signature, signed_input, padding.PKCS1v15(), hashes.SHA256())
        c4 = True
        detail = "RSA-PKCS1v15-SHA256(CRX3前缀||header_data||zip) 验证通过"
    except InvalidSignature:
        c4 = False
        detail = "签名不匹配（INVALID SIGNATURE）"
    except Exception as e:
        c4 = False
        detail = f"公钥/签名验证异常: {e}"
    checks.append(("[4] 签名有效性", c4, detail))
    if not c4:
        ok = False

    # [5] zip 完整性
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        bad = zf.testzip()
        names = zf.namelist()
        has_manifest = "manifest.json" in names
        c5 = (bad is None) and has_manifest
        checks.append(("[5] zip 完整性 & 含 manifest.json", c5,
                       f"badfile={bad!r} 文件数={len(names)} manifest={has_manifest}"))
    except Exception as e:
        c5 = False
        checks.append(("[5] zip 完整性", False, f"异常: {e}"))
    if not c5:
        ok = False

    return finish(checks, ok)


def finish(checks, ok):
    print()
    for name, passed, detail in checks:
        mark = "PASS" if passed else "FAIL"
        line = f"[{mark}] {name}"
        if detail:
            line += f"  —  {detail}"
        print(line)
    print()
    if ok:
        print("✅ 全部校验通过：该 CRX3 结构与密码学证明完整有效，可被 Chrome 接受。")
    else:
        print("❌ 存在失败项：该 CRX3 不符合规范，Chrome 将拒绝安装。")
    return 0 if ok else 1


def main():
    if len(sys.argv) >= 2:
        crx_path = sys.argv[1]
    else:
        # 取 dist 下最新的 .crx
        if not os.path.isdir(DIST_DIR):
            print(f"未找到 dist 目录: {DIST_DIR}")
            return 2
        crxs = [f for f in os.listdir(DIST_DIR) if f.endswith(".crx")]
        if not crxs:
            print("dist 目录下没有 .crx 文件")
            return 2
        crxs.sort(key=lambda n: os.path.getmtime(os.path.join(DIST_DIR, n)), reverse=True)
        crx_path = os.path.join(DIST_DIR, crxs[0])
    return verify(crx_path)


if __name__ == "__main__":
    sys.exit(main())
