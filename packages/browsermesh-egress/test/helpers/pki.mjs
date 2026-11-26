/**
 * A throwaway certificate authority and two server certificates, for the tests of the fetch form's TLS check only.
 *
 * The CA is not trusted by anything on any machine: a test hands it to the provider's exchange as the one authority it
 * accepts. `secure.test` has a certificate for `secure.test`; `other.test` has one for `other.test`, so serving it for the
 * name `secure.test` is a certificate for the wrong name. The keys protect nothing; they exist to be committed. Valid for
 * a hundred years, generated once with openssl (ECDSA P-256).
 */
export const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBsTCCAVegAwIBAgIUWuleoGWacrNUP1dS5FYSCrMX0KUwCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwaYnJvd3Nlcm1lc2gtZWdyZXNzIHRlc3QgQ0EwIBcNMjYxMTI1
MTgyMDEwWhgPMjEyNjExMDExODIwMTBaMCUxIzAhBgNVBAMMGmJyb3dzZXJtZXNo
LWVncmVzcyB0ZXN0IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkedS/GoZ
Qzu3ARkIhrdASKArJ4T8ztwS7tykdvbDlUvmbadMUpA+SYtamD+xlwmADso2eE3m
3ZwNHUtkGA4P96NjMGEwHQYDVR0OBBYEFAuIND2bTmOL+F2z3OUAUbohYFDjMB8G
A1UdIwQYMBaAFAuIND2bTmOL+F2z3OUAUbohYFDjMA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgIEMAoGCCqGSM49BAMCA0gAMEUCIF7ppkk92pTGsfHgauFx
hW1qHzwydaKBZYyvjfLBc5ZQAiEAzQL7FoCNKC/zG/2N4PZ5mVqBYdb7BbtlKt9v
Hg7odxs=
-----END CERTIFICATE-----
`

export const SECURE = {
  name: 'secure.test',
  cert: `-----BEGIN CERTIFICATE-----
MIIBuTCCAV+gAwIBAgIUfQ7UQfLcbwnI5c6YsHaW5hoobs4wCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwaYnJvd3Nlcm1lc2gtZWdyZXNzIHRlc3QgQ0EwIBcNMjYxMTI1
MTgyMDEwWhgPMjEyNjExMDExODIwMTBaMBYxFDASBgNVBAMMC3NlY3VyZS50ZXN0
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeItXHb0RT6qIaJ2sTrcqK6w+bhnG
T0Fy124mE/PrdO18yUa3MskRgkZwNkJz3qhoupOuhMTtgtXfzA8sfUv8qqN6MHgw
FgYDVR0RBA8wDYILc2VjdXJlLnRlc3QwCQYDVR0TBAIwADATBgNVHSUEDDAKBggr
BgEFBQcDATAdBgNVHQ4EFgQUqSNyrQVgNNBjKuoHTl02AbcxxIkwHwYDVR0jBBgw
FoAUC4g0PZtOY4v4XbPc5QBRuiFgUOMwCgYIKoZIzj0EAwIDSAAwRQIgWQ0n00bw
T0kD+p8UdvWot0RxBS85ZO/FttjT1Er84HQCIQCuG1sUWXsMP8tXu0K8Dd/14Unw
5VyxNy97MXa8o6Qvzg==
-----END CERTIFICATE-----
`,
  key: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIBzrUJ5/Q9+5efIQa68Qrzcz1mIOGyGPZ03lB5aVS8CPoAoGCCqGSM49
AwEHoUQDQgAEeItXHb0RT6qIaJ2sTrcqK6w+bhnGT0Fy124mE/PrdO18yUa3MskR
gkZwNkJz3qhoupOuhMTtgtXfzA8sfUv8qg==
-----END EC PRIVATE KEY-----
`,
}

export const OTHER = {
  name: 'other.test',
  cert: `-----BEGIN CERTIFICATE-----
MIIBtzCCAV2gAwIBAgIUfQ7UQfLcbwnI5c6YsHaW5hoobs8wCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwaYnJvd3Nlcm1lc2gtZWdyZXNzIHRlc3QgQ0EwIBcNMjYxMTI1
MTgyMDEwWhgPMjEyNjExMDExODIwMTBaMBUxEzARBgNVBAMMCm90aGVyLnRlc3Qw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASxuDnBNE9scd4jaSX6trZjWzvXqyvs
2MltQUlPRgxm1SYJELqqKKVOTiVaApTnWPttQnHu/6aphyPTSbRs9Vsbo3kwdzAV
BgNVHREEDjAMggpvdGhlci50ZXN0MAkGA1UdEwQCMAAwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwHQYDVR0OBBYEFP1BZcomOki8H2zm0JrH96Fwsk2IMB8GA1UdIwQYMBaA
FAuIND2bTmOL+F2z3OUAUbohYFDjMAoGCCqGSM49BAMCA0gAMEUCIGujmfZ/rCtZ
4ttngowAeRTj3JR3I2Ud1mP9nIY1hQ/AAiEAhLp6mW/3kLatraV9ckJdR9up0ahG
nFmlODZ/oDlTfck=
-----END CERTIFICATE-----
`,
  key: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINhyITbY5gw6/Nz4Z7f03vupOHoOm3O2D012wsCjI0uUoAoGCCqGSM49
AwEHoUQDQgAEsbg5wTRPbHHeI2kl+ra2Y1s716sr7NjJbUFJT0YMZtUmCRC6qiil
Tk4lWgKU51j7bUJx7v+mqYcj00m0bPVbGw==
-----END EC PRIVATE KEY-----
`,
}
