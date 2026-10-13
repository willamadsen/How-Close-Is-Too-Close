#importing libary to communicate with web servers 
import requests 


#DEFINING target url to let python know exactly where on the internet the data is 
#public url that doesnt require my credentials 
#stoing the url as a string to make reusing it easy 
url = "https://celestrak.org/pub/satcat.csv"



#USER FEEDBACK
#gives visual feedback to the user that the program is working and not frozen
print(f"Downloading full catalog from {url}")


#MAKING THE NETWORK REQUEST: THE CORE ACTION 
#tells my computer to open a background connection ti celstrack and ask to download the file found at the url we defined earlier 
# now the servers answer to our request (csv files and background data) is stored in the variable "response"
response = requests.get(url) 

if response.status_code == 200:
    with open("full_satcat.csv", "wb") as f:#opening a new binary file
        f.write(response.content) #putting raw data in file just opened 
        print("Download complete! File saved as 'full_satcat.csv'")
else:
    print(f"Failed to download. Status code: {response.status_code}")



#now sort for only the columns we want to keep and save as a new file

