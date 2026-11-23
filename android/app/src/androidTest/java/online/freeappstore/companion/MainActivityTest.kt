package online.freeappstore.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test

/** The real activity starts, signed out, on the Store tab, and the Sharing tab offers sign-in. */
class MainActivityTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun launchesSignedOutOnTheStore() {
        compose.onNodeWithText("Search apps").assertIsDisplayed()
        compose.onNodeWithText("Sharing").performClick()
        compose.onNodeWithText("Sign in to FreeAppStore").assertIsDisplayed()
    }
}
