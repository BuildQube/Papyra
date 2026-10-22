//! The plugin's error type, serialised as the message the WebView receives.

use papyra_core::PapyraError;
use serde::{Serialize, Serializer};

/// Prefixes `rethrowLoadError` in papyra's TypeScript strips to rethrow a typed
/// password error, exactly as the napi bindings tag theirs.
const TAG_PASSWORD_REQUIRED: &str = "papyra/password-required";
const TAG_INCORRECT_PASSWORD: &str = "papyra/incorrect-password";
#[cfg(feature = "tables")]
const TAG_ENCRYPTED: &str = "papyra/encrypted-workbook";

#[derive(Debug, thiserror::Error)]
pub enum Error {
  /// The document itself: unparseable, encrypted, a page out of range.
  #[error("{}", tagged(.0))]
  Papyra(#[from] PapyraError),
  /// An id the WebView holds that the host does not — closed, or freed by a reload.
  #[error("papyra: no open document {0}")]
  NotOpen(u32),
  #[error("papyra: open takes the file's bytes as the request body")]
  NotBytes,
  #[error("papyra: the {0} header is not percent-encoded UTF-8")]
  Header(&'static str),
  /// An id that names a document of another format than the command reads.
  #[error("papyra: document {0} is not a {1}")]
  WrongKind(u32, &'static str),
  #[cfg(feature = "tiff")]
  #[error("{0}")]
  Tiff(#[from] papyra_tiff::TiffError),
  /// A workbook error, an encrypted one tagged as the napi bindings tag it.
  #[cfg(feature = "tables")]
  #[error("{}", tagged_table(.0))]
  Tables(#[from] papyra_tables::TableError),
  #[cfg(feature = "tables")]
  #[error("papyra: bad workbook options: {0}")]
  Options(String),
  /// The host failed around the work: a poisoned lock, a blocking task that died.
  #[error("papyra: {0}")]
  Host(String),
}

/// A document error as the napi bindings word it, password failures tagged.
fn tagged(e: &PapyraError) -> String {
  match e {
    PapyraError::PasswordRequired => format!("{TAG_PASSWORD_REQUIRED} {e}"),
    PapyraError::IncorrectPassword => format!("{TAG_INCORRECT_PASSWORD} {e}"),
    _ => e.to_string(),
  }
}

#[cfg(feature = "tables")]
fn tagged_table(e: &papyra_tables::TableError) -> String {
  match e {
    papyra_tables::TableError::Encrypted => format!("{TAG_ENCRYPTED} {e}"),
    _ => e.to_string(),
  }
}

/// As a plain string: the WebView side reads errors as messages, and tagged ones by
/// their prefix.
impl Serialize for Error {
  fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&self.to_string())
  }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn password_failures_are_tagged_and_the_rest_are_not() {
    assert!(
      Error::from(PapyraError::PasswordRequired)
        .to_string()
        .starts_with("papyra/password-required ")
    );
    assert!(
      Error::from(PapyraError::IncorrectPassword)
        .to_string()
        .starts_with("papyra/incorrect-password ")
    );
    assert_eq!(
      Error::from(PapyraError::PageOutOfRange(9)).to_string(),
      "page 9 out of range"
    );
  }

  #[cfg(feature = "tables")]
  #[test]
  fn an_encrypted_workbook_is_tagged() {
    assert!(
      Error::from(papyra_tables::TableError::Encrypted)
        .to_string()
        .starts_with("papyra/encrypted-workbook ")
    );
  }
}
