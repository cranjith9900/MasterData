import com.opencsv.CSVParserBuilder;
import com.opencsv.CSVReader;
import com.opencsv.CSVReaderBuilder;
import com.opencsv.*;
import com.opencsv.exceptions.CsvValidationException;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

public class BulkUserImportNew_HR {

    private static Properties config = new Properties();
    private static final int BATCH_SIZE = 1000;

    static {
        try (InputStream input = BulkUserImportNew_HR.class.getClassLoader().getResourceAsStream("config.properties")) {
            if (input == null) {
                throw new FileNotFoundException("config.properties not found on classpath.");
            }
            config.load(input);
        } catch (IOException e) {
            e.printStackTrace();
            throw new RuntimeException("Failed to load configuration properties.", e);
        }
    }

    public static void main(String[] args) {
        System.out.println("CSV input file: " + config.getProperty("csvFilePath"));
        List<JSONArray> batches = readUsersFromCsvInBatches(config.getProperty("csvFilePath"), BATCH_SIZE);
        int batchNumber = 1;

        for (JSONArray batch : batches) {
            if (batch.length() > 0) {
                long startTime = System.nanoTime();
                System.out.println("Sending batch " + batchNumber + " with " + batch.length() + " records.");
                System.out.println("JSON payload for batch " + batchNumber + ":");
                System.out.println(batch.toString(2));
                boolean sent = sendPostRequest(batch);
                long endTime = System.nanoTime();
                long timeElapsed = endTime - startTime;
                System.out.println("Batch " + batchNumber + (sent ? " sent successfully." : " failed.") + " Time taken: " + (timeElapsed / 1_000_000_000.0) + " seconds");
                batchNumber++;
            }
        }
    }

    private static List<JSONArray> readUsersFromCsvInBatches(String csvFile, int batchSize) {
        List<JSONArray> batches = new ArrayList<>();
        JSONArray currentBatch = new JSONArray();

        try (CSVReader reader = new CSVReaderBuilder(new FileReader(csvFile))
                .withCSVParser(new CSVParserBuilder()
                        .withSeparator(',')
                        .withQuoteChar('"')
                        .build())
                .build()) {
            String[] line;
            String[] header = reader.readNext(); // Skip header
            if (header != null) {
                System.out.println("CSV header: " + String.join(",", header));
            }

            while ((line = reader.readNext()) != null) {
                System.out.println("CSV row: " + String.join(",", line));
                JSONObject jsonObject = createJsonObjectFromCsvLine(line);
                currentBatch.put(jsonObject);
                if (currentBatch.length() == batchSize) {
                    batches.add(currentBatch);
                    currentBatch = new JSONArray(); // Start a new batch
                }
            }
            if (currentBatch.length() > 0) {
                batches.add(currentBatch);
            }
        } catch (IOException | CsvValidationException | JSONException e) {
            e.printStackTrace();
        }
        return batches;
    }

    private static JSONObject createJsonObjectFromCsvLine(String[] userData) throws JSONException {
        if (userData.length < 2) {
            throw new IllegalArgumentException("CSV line has insufficient columns.");
        }
        JSONObject jsonObject = new JSONObject();
        putIfNotEmpty(jsonObject, "userName", userData[0]);
        putIfNotEmpty(jsonObject, "email", userData[1]);
        //putIfNotEmpty(jsonObject, "firstName", userData[3]);
        //putIfNotEmpty(jsonObject, "lastName", userData[4]);
        putIfNotEmpty(jsonObject, "defaultCompanyEntityErpId", userData[5]);
        putIfNotEmpty(jsonObject, "locationErpId", userData[7]);
        putIfNotEmpty(jsonObject, "defaultCurrencyCode", userData[14]);
        putIfNotEmpty(jsonObject, "employeeId", userData[10]);
        putIfNotEmpty(jsonObject, "managerId", userData[11]);
        putIfNotEmpty(jsonObject, "managerEmail", userData[12]);

        //putIfNotEmpty(jsonObject, "purchasingEntityErpId", userData[8]);
        //putIfNotEmpty(jsonObject, "employeeId", userData[9]);
        putIfNotEmpty(jsonObject, "siteErpId", userData[8]);
        putIfNotEmpty(jsonObject, "costCenterErpId", userData[6]);
        /*
        if (userData[13] != null && !userData[13].trim().isEmpty()) {
            JSONArray groupsArray = new JSONArray();
            String[] groups = userData[13].split(";"); // Split by comma
            for (String group : groups) {
                if (!group.trim().isEmpty()) {
                    groupsArray.put(group.trim()); // Add trimmed group to the JSON array
                }
            }
            jsonObject.put("groups", groupsArray); // Set the "groups" field as a JSONArray
        }
        */
        //putIfNotEmpty(jsonObject, "site", userData[10]);

        jsonObject.put("cognitoUser", true);
        jsonObject.put("active", true);
        jsonObject.put("createIfMissing", true);
        return jsonObject;
    }

    private static void putIfNotEmpty(JSONObject jsonObject, String key, String value) throws JSONException {
        if (value != null && !value.trim().isEmpty()) {
            jsonObject.put(key, value);
        }
    }

    private static boolean sendPostRequest(JSONArray jsonArray) {
        try {
            URL url = new URL(config.getProperty("apiUrlHR"));
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            setConnectionHeaders(connection);
            System.out.println(jsonArray);
            writeJsonArrayToConnection(jsonArray, connection);
            boolean success = handleConnectionResponse(connection);
            connection.disconnect();
            return success;
        } catch (IOException e) {
            e.printStackTrace();
            return false;
        }
    }

    private static void setConnectionHeaders(HttpURLConnection connection) throws IOException {
        connection.setRequestMethod("POST");
        String authorization = buildAuthorizationHeader(config.getProperty("apiToken"));
        connection.setRequestProperty("Authorization", authorization);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        System.out.println("Authorization header format: " + maskToken(authorization));
    }

    private static String buildAuthorizationHeader(String apiToken) {
        if (apiToken == null) {
            return "";
        }
        String token = apiToken.trim();
        if (token.startsWith("TKTKey") || token.startsWith("Bearer ")) {
            return token;
        }
        return "TKTKey" + token;
    }

    private static String maskToken(String token) {
        if (token == null || token.length() < 16) {
            return "[empty or too short]";
        }
        return token.substring(0, 10) + "..." + token.substring(token.length() - 6);
    }

    private static void writeJsonArrayToConnection(JSONArray jsonArray, HttpURLConnection connection) throws IOException {
        try (OutputStream os = connection.getOutputStream()) {
            byte[] input = jsonArray.toString().getBytes(StandardCharsets.UTF_8);
            os.write(input, 0, input.length);
        }
    }

    private static boolean handleConnectionResponse(HttpURLConnection connection) throws IOException {
        int responseCode = connection.getResponseCode();
        System.out.println("Response Code : " + responseCode);

        StringBuilder response = new StringBuilder();
        InputStream inputStream = (responseCode >= 200 && responseCode < 300) ?
                connection.getInputStream() : connection.getErrorStream();

        try (BufferedReader br = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String responseLine;
            while ((responseLine = br.readLine()) != null) {
                response.append(responseLine.trim());
            }
        }
        System.out.println(response.toString());
        return responseCode >= 200 && responseCode < 300;
    }
}
