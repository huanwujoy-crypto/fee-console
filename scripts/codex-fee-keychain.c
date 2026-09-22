#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// The secret is read from stdin. Only the allowlisted local Keychain item is written.
int main(int argc, char **argv) {
  if (argc != 3 || strncmp(argv[1], "fee-console.codex.", 18) != 0 ||
      strcmp(argv[2], "huanwujoy-crypto") != 0) return 2;
  unsigned char bytes[4096];
  size_t count = 0;
  while (count < sizeof(bytes)) {
    ssize_t n = read(STDIN_FILENO, bytes + count, sizeof(bytes) - count);
    if (n < 0) return 2;
    if (n == 0) break;
    count += (size_t)n;
  }
  if (count == 0 || count == sizeof(bytes)) return 2;
  CFStringRef service = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);
  CFStringRef account = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  CFDataRef value = CFDataCreate(NULL, bytes, (CFIndex)count);
  memset(bytes, 0, sizeof(bytes));
  if (!service || !account || !value) return 2;
  const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecAttrSynchronizable};
  const void *values[] = {kSecClassGenericPassword, service, account, kCFBooleanFalse};
  CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 4,
                                             &kCFTypeDictionaryKeyCallBacks,
                                             &kCFTypeDictionaryValueCallBacks);
  const void *updateKeys[] = {kSecValueData};
  const void *updateValues[] = {value};
  CFDictionaryRef update = CFDictionaryCreate(NULL, updateKeys, updateValues, 1,
                                              &kCFTypeDictionaryKeyCallBacks,
                                              &kCFTypeDictionaryValueCallBacks);
  OSStatus status = SecItemUpdate(query, update);
  if (status == errSecItemNotFound) {
    CFMutableDictionaryRef addition = CFDictionaryCreateMutableCopy(NULL, 0, query);
    CFDictionarySetValue(addition, kSecValueData, value);
    CFDictionarySetValue(addition, kSecAttrAccessible, kSecAttrAccessibleWhenUnlocked);
    status = SecItemAdd(addition, NULL);
    CFRelease(addition);
  }
  CFRelease(update);
  CFRelease(query);
  CFRelease(value);
  CFRelease(account);
  CFRelease(service);
  return status == errSecSuccess ? 0 : 3;
}
